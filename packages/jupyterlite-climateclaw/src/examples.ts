// One slash command per configured example: `/name` becomes the example's prompt.

import type { ChatCommand, IChatCommandProvider, IInputModel } from "@jupyter/chat";

import { exampleCommandName, type Example } from "./config.js";

export class ExamplesCommandProvider implements IChatCommandProvider {
  readonly id = "climateclaw:examples";
  private readonly commands: Array<{ name: string; example: Example }>;

  constructor(examples: Example[]) {
    const taken = new Set<string>(["clear"]);
    this.commands = examples.map((example) => ({
      name: `/${exampleCommandName(example, taken)}`,
      example,
    }));
  }

  get names(): string[] {
    return this.commands.map((c) => c.name);
  }

  async listCommandCompletions(input: IInputModel): Promise<ChatCommand[]> {
    const word = input.currentWord;
    if (!word || !/^\/[\w-]*$/.test(word)) return [];
    return this.commands
      .filter((c) => c.name.startsWith(word))
      .map((c) => ({
        name: c.name,
        providerId: this.id,
        description: c.example.title,
        replaceWith: c.example.prompt,
      }));
  }

  async onSubmit(input: IInputModel): Promise<void> {
    const trimmed = input.value.trim();
    const match = this.commands.find((c) => c.name === trimmed);
    if (match) input.value = match.example.prompt;
  }
}
