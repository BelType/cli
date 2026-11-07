// prosemirror-stores is JavaScript with JSDoc and ships no declarations; the two entries the mail merge reads, as far as it reads them.

declare module 'prosemirror-stores/graph' {
  export interface Graph {
    get(id: string, key: string): unknown;
    set(id: string, key: string, value: unknown): unknown;
    serialize(): string;
  }
  export function openBlock(text: string, options?: { rows?: Map<string, object[]> }): Graph;
}

declare module 'prosemirror-stores/microdata' {
  import type { Graph } from 'prosemirror-stores/graph';
  export function writeMicrodata(root: Element, graph: Graph): number;
}
