import type { z } from "zod";
import { routeTask } from "./ai-router";
import { AI_SCHEMAS } from "./ai-schemas";
import { loadAiConnections } from "./ai-settings";
import { describeResult, TEST_TASKS, type TestResult } from "./ai-test-tasks";
import type { SecretBox } from "./crypto";
import type { UserDbRunner } from "./db";
import { jsonResponse, serverError } from "./http";
import { logEvent } from "./log";

// Server-only: POST /api/ai/test. Runs the 4 sample tasks on the signed-in user's saved models,
// one after another (kind to a local model), with no template. Only pass or fail, the model
// that answered and a short reason go back: never keys, prompts or answers.

type Deps = { runAsUser: UserDbRunner; box: () => SecretBox };

export const aiTestHandler = ({ runAsUser, box }: Deps) => ({
  post: async (): Promise<Response> => {
    try {
      const connections = await runAsUser(async (db) => ({
        sort: await loadAiConnections(db, "sort", box()),
        draft: await loadAiConnections(db, "draft", box()),
        tier3: await loadAiConnections(db, "tier3", box()),
      }));
      if (connections.draft.length === 0) {
        return jsonResponse({ error: "Save a model in AI settings first, then test it." }, 400);
      }
      const results: TestResult[] = [];
      for (const task of TEST_TASKS) {
        const result = await routeTask(connections[task.task], {
          messages: task.messages,
          schema: AI_SCHEMAS[task.schema] as z.ZodType,
        });
        results.push(describeResult(task, result));
      }
      logEvent("ai_test.run", { passed: results.filter((r) => r.pass).length, of: results.length });
      return jsonResponse({ results });
    } catch (error) {
      return serverError("ai_test.failed", error);
    }
  },
});
