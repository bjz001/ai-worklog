export function parseEnvironment(source: string): Map<string, string>;

export function buildCollectorEnvironment(options: {
  projectEnvironment: Map<string, string>;
  existing: Map<string, string>;
  home: string;
  nodeBinary: string;
  generatedPathHmacKey: string;
}): string;

export function main(): Promise<void>;
