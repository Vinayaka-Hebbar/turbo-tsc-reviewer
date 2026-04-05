import {
  info,
  error,
  getInput,
  summary,
  warning,
  setFailed,
} from "@actions/core";
import { getOctokit, context } from "@actions/github";
import { execSync } from "child_process";
import path from "path";

/**
 * @typedef CommentPayload
 * @property {string} identifier
 * @property {string} owner
 * @property {string} repo
 * @property {number} prNumber
 * @property {string} prCommentBody
 * @property {string} token
 * @property {boolean} hasErrors
 */

/**
 *
 * @param {CommentPayload} payload
 */
async function createPRComment(payload) {
  const { identifier, owner, repo, prNumber, prCommentBody, token, hasErrors } =
    payload;
  const octokit = getOctokit(token);
  try {
    const { data: comments } = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: prNumber,
      per_page: 100,
    });

    const existingComment = comments.find((c) => c.body?.includes(identifier));

    if (existingComment) {
      if (!hasErrors) {
        info(
          `Deleting existing PR summary comment (ID: ${existingComment.id}) as no issues were found.`,
        );
        await octokit.rest.issues.deleteComment({
          owner,
          repo,
          comment_id: existingComment.id,
        });
      } else {
        info(
          `Updating existing PR summary comment (ID: ${existingComment.id}).`,
        );
        await octokit.rest.issues.updateComment({
          owner,
          repo,
          comment_id: existingComment.id,
          body: prCommentBody,
        });
      }
    } else if (hasErrors) {
      info("Creating new PR summary comment.");
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body: prCommentBody,
      });
    }
  } catch (e) {
    warning(`Failed to sync PR summary comment: ${e.message}`);
  }
}

/**
 *
 * @param {string[]} errors
 * @returns {import('@actions/core').Summary}
 */
function createReviewSummary(errors, sha) {
  const { serverUrl, runId } = context;
  const { owner, repo } = context.repo;
  const jobSummaryUrl = `${serverUrl}/${owner}/${repo}/actions/runs/${runId}`;
  // 2. Build Report Content using summary API
  const reviewSummary = summary
    .addHeading(
      errors.length === 0
        ? "✅ No TypeScript issues found"
        : `❌ ${errors.length} TypeScript issues identified`,
      3,
    )
    .addRaw(
      errors.length === 0
        ? "All clear! No TypeScript issues were identified across the workspace."
        : `Discovered <b>${errors.length}</b> issues that require attention.`,
    );

  if (errors.length > 0) {
    reviewSummary.addTable([
      [
        { data: "File", header: true },
        { data: "Line", header: true },
        { data: "Message", header: true },
      ],
      ...errors.slice(0, 15).map((err) => {
        const fileUrl = `${serverUrl}/${owner}/${repo}/blob/${sha}/${err.path}#L${err.line}`;
        const clickablePath = `<a href="${fileUrl}">${err.path}</a>`;
        return [clickablePath, err.line.toString(), err.body];
      }),
    ]);

    if (errors.length > 15) {
      reviewSummary.addRaw(
        `\n\n*Showing top 15 of ${errors.length} issues. [View all details](${jobSummaryUrl}).*`,
      );
    }
  }

  reviewSummary.addRaw("\n\n---\n*Reported by Turbo TSC Reviewer 🚀*");
  return reviewSummary;
}

/**
 * Turborepo PR Reviewer
 * Processes Turborepo JSON output and reports TypeScript errors via GitHub Annotations and a persistent PR summary.
 */
async function run() {
  info("Initializing quality review analysis.");

  const pkgPathCache = new Map();

  /**
   * Resolve workspace directory using npm dependency resolution.
   */
  function getWorkspaceDir(pkgName) {
    if (pkgPathCache.has(pkgName)) return pkgPathCache.get(pkgName);

    try {
      const output = execSync(`npm ls ${pkgName} --json`, { encoding: "utf8" });
      const data = JSON.parse(output);

      const resolved = data.dependencies[pkgName]?.resolved;
      if (!resolved) return null;

      const rawPath = resolved.replace(/^file:/, "").replace(/^(\.\.\/)+/, "");
      const absolutePath = path.resolve(rawPath);
      const relativePath = path.relative(process.cwd(), absolutePath);

      pkgPathCache.set(pkgName, relativePath);
      return relativePath;
    } catch (e) {
      error(`Failed to resolve workspace path for package: ${pkgName}`);
      return null;
    }
  }

  const task = getInput("task") || "check-types";
  info(`Executing quality review analysis for task: ${task}`);

  let output = "";
  try {
    const options = [
      `npx turbo run ${task}`,
      "--output-logs=errors-only",
      "--json",
    ];

    output = execSync(options.join(" "), {
      encoding: "utf8",
      stdio: ["inherit", "pipe", "pipe"],
    }).toString();
  } catch (e) {
    output = (e.stdout || "") + (e.stderr || "");
  }

  const lines = output.split("\n");
  const errors = [];
  const seenErrors = new Set();

  for (const line of lines) {
    if (!line.trim()) continue;

    try {
      const entry = JSON.parse(line);

      if (entry.source?.includes("#") && entry.text?.includes("error TS")) {
        const [pkgName] = entry.source.split("#");
        const workspaceDir = getWorkspaceDir(pkgName);

        if (!workspaceDir) continue;

        const tscPattern =
          /^(.*?)(?:\(|\:)(\d+)(?:\,|\:).*?error TS(\d+): (.*)$/;
        const match = entry.text.match(tscPattern);

        if (match) {
          const [, filePath, lineNum, errorCode, msg] = match;
          const errorPath = path.join(workspaceDir, filePath.trim());
          const line = parseInt(lineNum);
          const body = `[TS${errorCode}] ${msg.trim()}`;

          const errorKey = `${errorPath}:${line}:${body}`;
          if (!seenErrors.has(errorKey)) {
            errors.push({ path: errorPath, line, body });
            seenErrors.add(errorKey);
          }
        }
      }
    } catch (e) {
      continue;
    }
  }

  // Prepare PR Summary comment & Job Summary
  const identifier = "<!-- tsc-reviewer-summary -->";
  const { payload } = context;
  const { owner, repo } = context.repo;
  const reporter = getInput("reporter") || "github-pr-check";
  const token = getInput("github_token") || process.env.GITHUB_TOKEN;

  if (!token) {
    warning(
      "Authentication Error: github_token is missing. Please ensure you pass it in your workflow.",
    );
  }

  const octokit = getOctokit(token);
  const prNumber = payload.pull_request?.number || payload.issue?.number;
  const sha = payload.pull_request?.head?.sha || context.sha;

  const useCheck = reporter.includes("check") || reporter === "all";
  const useComment = reporter.includes("review") || reporter === "all";

  // 1. Create GitHub Check Run
  let checkRunId = null;
  if (useCheck && sha) {
    try {
      const { data } = await octokit.rest.checks.create({
        owner,
        repo,
        name: "tsc",
        head_sha: sha,
        status: "in_progress",
        started_at: new Date().toISOString(),
      });
      checkRunId = data.id;
      info(`Successfully created Check Run "tsc" (ID: ${checkRunId}).`);
    } catch (e) {
      if (e.status === 403) {
        warning(
          `Failed to create "tsc" check: 403 Forbidden. Please ensure your workflow has "permissions: checks: write".`,
        );
      } else {
        warning(`Check Run creation failed: ${e.message}`);
      }
    }
  }

  // Workflow Annotations
  for (const err of errors) {
    error(err.body, {
      file: err.path,
      startLine: err.line,
    });
  }

  const reviewSummary = createReviewSummary(errors, sha);

  const summaryBody = reviewSummary.stringify();
  const prCommentBody = summaryBody + `\n\n${identifier}`;
  const checkTitle =
    errors.length > 0 ? `${errors.length} errors found` : "Success";

  // 3. Sync Persistent PR Summary Comment
  if (useComment && prNumber) {
    await createPRComment({
      identifier,
      owner,
      repo,
      prNumber,
      prCommentBody,
      token,
      hasErrors: errors.length > 0,
    });
  }

  // 4. Finalize Check Run
  if (checkRunId) {
    try {
      const conclusion = errors.length > 0 ? "failure" : "success";
      await octokit.rest.checks.update({
        owner,
        repo,
        check_run_id: checkRunId,
        status: "completed",
        conclusion: conclusion,
        completed_at: new Date().toISOString(),
        output: {
          title: checkTitle,
          summary: summaryBody,
          annotations: errors.slice(0, 50).map((err) => ({
            path: err.path,
            start_line: err.line,
            end_line: err.line,
            annotation_level: "failure",
            message: err.body,
          })),
        },
      });
      info(`Finalized Check Run as ${conclusion}.`);
    } catch (e) {
      warning(`Failed to finalize Check Run: ${e.message}`);
    }
  }

  if (errors.length > 0) {
    setFailed(`Identified ${errors.length} TypeScript errors.`);
  } else {
    info("Analysis complete: No issues identified.");
  }
}

run().catch((err) => {
  setFailed(err.message);
});
