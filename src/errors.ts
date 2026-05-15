export class ClawpatchError extends Error {
  public readonly exitCode: number;
  public readonly code: string;

  public constructor(message: string, exitCode = 1, code = "runtime") {
    super(message);
    this.name = "ClawpatchError";
    this.exitCode = exitCode;
    this.code = code;
  }
}

export function assertDefined<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) {
    throw new ClawpatchError(message);
  }
  return value;
}
