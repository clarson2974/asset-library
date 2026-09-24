import { json, type RequestHandler } from "@sveltejs/kit";
import { getAiConfig, updateAiConfig, type AiConfig } from "$lib/server/ai";
import { requireUserCapability } from "$lib/server/auth";

export const GET: RequestHandler = async ({ locals }) => {
  if (!(await requireUserCapability(locals.user, "settings.manage"))) {
    return json({ error: "Forbidden." }, { status: 403 });
  }

  const config = await getAiConfig();
  return json({ config });
};

export const PATCH: RequestHandler = async ({ locals, request }) => {
  if (!(await requireUserCapability(locals.user, "settings.manage"))) {
    return json({ error: "Forbidden." }, { status: 403 });
  }
  const body = (await request.json()) as Partial<AiConfig>;

  const next = await updateAiConfig({
    enabled: body.enabled,
    baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : undefined,
    model: typeof body.model === "string" ? body.model : undefined,
    apiKey: typeof body.apiKey === "string" ? body.apiKey : undefined,
    timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : undefined,
    temperature:
      typeof body.temperature === "number" ? body.temperature : undefined,
    disableThinking:
      typeof body.disableThinking === "boolean"
        ? body.disableThinking
        : undefined,
    reasoningEffort:
      typeof body.reasoningEffort === "string"
        ? body.reasoningEffort
        : undefined,
    customInstruction:
      typeof body.customInstruction === "string"
        ? body.customInstruction
        : undefined,
  });

  return json({ config: next });
};
