import { Injectable } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';
import { CreateCollectionTool } from './create-collection.tool';
import { GetRelatedResourcesTool } from './get-related-resources.tool';
import { GetResourceTool } from './get-resource.tool';
import { SearchLibraryTool } from './search-library.tool';
import { AssistantTool } from './tool.types';

export type ParsedCall =
  | { ok: true; tool: AssistantTool; args: object }
  | { ok: false; error: string };

@Injectable()
export class ToolRegistry {
  private readonly tools: Map<string, AssistantTool>;

  constructor(
    search: SearchLibraryTool,
    getResource: GetResourceTool,
    related: GetRelatedResourcesTool,
    createCollection: CreateCollectionTool,
  ) {
    this.tools = new Map(
      ([search, getResource, related, createCollection] as AssistantTool[]).map(
        (t) => [t.name, t],
      ),
    );
  }

  /** Gemini `tools` payload. */
  declarations() {
    return [
      {
        functionDeclarations: [...this.tools.values()].map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      },
    ];
  }

  /** Validates model-supplied arguments; unknown tools and fields are rejected. */
  async parse(name: string, rawArgs: unknown): Promise<ParsedCall> {
    const tool = this.tools.get(name);
    if (!tool) return { ok: false, error: `Unknown tool "${name}"` };
    if (
      rawArgs !== undefined &&
      (typeof rawArgs !== 'object' ||
        rawArgs === null ||
        Array.isArray(rawArgs))
    ) {
      return { ok: false, error: 'Arguments must be an object' };
    }
    const args = plainToInstance(tool.argsType, rawArgs ?? {});
    const errors = await validate(args, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    if (errors.length) {
      return {
        ok: false,
        error: `Invalid arguments: ${flatten(errors).join('; ')}`,
      };
    }
    return { ok: true, tool, args };
  }
}

function flatten(errors: ValidationError[]): string[] {
  return errors.flatMap((e) => [
    ...Object.values(e.constraints ?? {}),
    ...flatten(e.children ?? []),
  ]);
}
