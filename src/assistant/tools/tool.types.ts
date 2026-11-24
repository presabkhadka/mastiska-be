import type { EntityManager } from 'typeorm';

export interface ToolContext {
  /** Always the conversation owner; never taken from model arguments. */
  userId: string;
  /** Set for approved writes, so the side effect commits with the tool-call status. */
  manager?: EntityManager;
}

export interface AssistantTool<A extends object = object> {
  name: string;
  description: string;
  /** Gemini function-declaration schema (OpenAPI subset). */
  parameters: Record<string, unknown>;
  /** class-validator DTO with the same fields; the source of truth for validation. */
  argsType: new () => A;
  requiresApproval: boolean;
  execute(args: A, ctx: ToolContext): Promise<Record<string, unknown>>;
  /** Checks a write before asking the user to approve it; returns an error message. */
  precheck?(args: A, ctx: ToolContext): Promise<string | null>;
  /** Summary shown to the user when approval is needed; must say exactly what will change. */
  describe?(args: A, ctx: ToolContext): Promise<string>;
}

/** Errors a tool reports back to the model (not bugs). */
export class ToolError extends Error {}
