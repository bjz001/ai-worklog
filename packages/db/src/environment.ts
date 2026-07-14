import { loadEnvFile } from "node:process";
import { resolve } from "node:path";

export function loadLocalEnvironment(
  filePath = resolve(process.cwd(), ".env.local")
): boolean {
  try {
    loadEnvFile(filePath);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

export function safeDatabaseErrorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z0-9_]+$/.test(error.code)
  ) {
    return error.code;
  }
  return "DATABASE_OPERATION_FAILED";
}
