import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";

export interface ResolvedLlmAddress {
  address: string;
  family: 4 | 6;
}

export type LlmResolver = (
  hostname: string
) => Promise<readonly { address: string; family?: number }[]>;

function ipv4Octets(address: string): [number, number, number, number] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number(part));
  if (
    octets.some(
      (part, index) =>
        !/^\d{1,3}$/u.test(parts[index]!) ||
        !Number.isInteger(part) ||
        part < 0 ||
        part > 255
    )
  ) {
    return null;
  }
  return octets as [number, number, number, number];
}

function isPublicIpv4(address: string): boolean {
  const octets = ipv4Octets(address);
  if (!octets) return false;
  const [a, b, c] = octets;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function expandIpv6(address: string): number[] | null {
  if (address.includes("%") || isIP(address) !== 6) return null;
  let normalized = address.toLowerCase();
  if (normalized.includes(".")) {
    const separator = normalized.lastIndexOf(":");
    const octets = ipv4Octets(normalized.slice(separator + 1));
    if (separator < 0 || !octets) return null;
    const high = (octets[0] << 8) | octets[1];
    const low = (octets[2] << 8) | octets[3];
    normalized = `${normalized.slice(0, separator)}:${high.toString(16)}:${low.toString(16)}`;
  }
  if ((normalized.match(/::/gu) ?? []).length > 1) return null;
  const [left = "", right] = normalized.split("::");
  const leftWords = left ? left.split(":") : [];
  const rightWords = right === undefined || right === "" ? [] : right.split(":");
  const missing = 8 - leftWords.length - rightWords.length;
  if ((right === undefined && missing !== 0) || (right !== undefined && missing < 1)) {
    return null;
  }
  const words = [
    ...leftWords,
    ...Array.from({ length: missing }, () => "0"),
    ...rightWords
  ];
  if (words.length !== 8 || words.some((word) => !/^[0-9a-f]{1,4}$/u.test(word))) {
    return null;
  }
  return words.map((word) => Number.parseInt(word, 16));
}

function isInIpv6Prefix(
  words: readonly number[],
  prefix: readonly number[],
  prefixLength: number
): boolean {
  const wholeWords = Math.floor(prefixLength / 16);
  for (let index = 0; index < wholeWords; index += 1) {
    if (words[index] !== (prefix[index] ?? 0)) return false;
  }
  const remainingBits = prefixLength % 16;
  if (remainingBits === 0) return true;
  const mask = (0xffff << (16 - remainingBits)) & 0xffff;
  return ((words[wholeWords] ?? 0) & mask) ===
    ((prefix[wholeWords] ?? 0) & mask);
}

const NON_ENDPOINT_GLOBAL_UNICAST_PREFIXES = [
  { prefix: [0x2001, 0], length: 23 },
  { prefix: [0x2001, 0x0db8], length: 32 },
  { prefix: [0x2002], length: 16 },
  { prefix: [0x2620, 0x004f, 0x8000], length: 48 },
  { prefix: [0x3ffe], length: 16 },
  { prefix: [0x3fff, 0], length: 20 }
] as const;

function isPublicIpv6(address: string): boolean {
  const words = expandIpv6(address);
  if (!words) return false;

  const ipv4Mapped = words.slice(0, 5).every((word) => word === 0) &&
    words[5] === 0xffff;
  const ipv4Translated = words.slice(0, 4).every((word) => word === 0) &&
    words[4] === 0xffff && words[5] === 0;
  const ipv4Compatible = words.slice(0, 6).every((word) => word === 0);
  const nat64WellKnown = words[0] === 0x64 && words[1] === 0xff9b &&
    words.slice(2, 6).every((word) => word === 0);
  if (ipv4Mapped || ipv4Translated || ipv4Compatible || nat64WellKnown) {
    return false;
  }

  const isCurrentlyAllocatedGlobalUnicast =
    (words[0]! & 0xe000) === 0x2000;
  if (!isCurrentlyAllocatedGlobalUnicast) return false;
  return !NON_ENDPOINT_GLOBAL_UNICAST_PREFIXES.some(({ prefix, length }) =>
    isInIpv6Prefix(words, prefix, length)
  );
}

export function normalizeLlmHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[|\]$/gu, "").replace(/\.$/u, "");
}

export function isPublicLlmIpAddress(address: string): boolean {
  const normalized = normalizeLlmHostname(address);
  const family = isIP(normalized);
  if (family === 4) return isPublicIpv4(normalized);
  if (family === 6) return isPublicIpv6(normalized);
  return false;
}

export function isUnsafeLlmHostname(hostname: string): boolean {
  const normalized = normalizeLlmHostname(hostname);
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local")
  ) {
    return true;
  }
  return isIP(normalized) !== 0 && !isPublicLlmIpAddress(normalized);
}

export const defaultLlmResolver: LlmResolver = async (hostname) => {
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return answers.map((answer) => ({
    address: answer.address,
    family: answer.family
  }));
};

export async function resolvePublicLlmDestination(
  baseUrl: string,
  resolver: LlmResolver = defaultLlmResolver
): Promise<readonly ResolvedLlmAddress[]> {
  const url = new URL(baseUrl);
  const hostname = normalizeLlmHostname(url.hostname);
  if (isUnsafeLlmHostname(hostname)) throw new Error("UNSAFE_LLM_DESTINATION");

  let answers: readonly { address: string; family?: number }[];
  if (isIP(hostname) !== 0) {
    answers = [{ address: hostname }];
  } else {
    answers = await resolver(hostname);
  }
  if (answers.length === 0) throw new Error("UNSAFE_LLM_DESTINATION");

  const verified = answers.map(({ address }) => {
    const normalized = normalizeLlmHostname(address);
    const family = isIP(normalized);
    if ((family !== 4 && family !== 6) || !isPublicLlmIpAddress(normalized)) {
      throw new Error("UNSAFE_LLM_DESTINATION");
    }
    return { address: normalized, family } as ResolvedLlmAddress;
  });
  return verified.filter(
    (answer, index) =>
      verified.findIndex(
        (candidate) =>
          candidate.address === answer.address && candidate.family === answer.family
      ) === index
  );
}

export function createPinnedLlmLookup(
  addresses: readonly ResolvedLlmAddress[]
): LookupFunction {
  const verified = addresses.filter(
    (answer) =>
      isIP(answer.address) === answer.family &&
      isPublicLlmIpAddress(answer.address)
  );
  if (verified.length !== addresses.length || verified.length === 0) {
    throw new Error("UNSAFE_LLM_DESTINATION");
  }
  return (_hostname, options, callback) => {
    const family = options.family === 4 || options.family === 6
      ? options.family
      : 0;
    const eligible = family === 0
      ? verified
      : verified.filter((answer) => answer.family === family);
    if (eligible.length === 0) {
      const error = Object.assign(new Error("No verified address for family"), {
        code: "ENOTFOUND"
      });
      callback(error, "", family || undefined);
      return;
    }
    if (options.all) {
      callback(null, eligible.map((answer) => ({ ...answer })));
      return;
    }
    callback(null, eligible[0]!.address, eligible[0]!.family);
  };
}

function responseHeaders(
  headers: Readonly<Record<string, string | string[] | undefined>>
): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) result.append(name, item);
    } else if (value !== undefined) {
      result.set(name, value);
    }
  }
  return result;
}

export async function pinnedHttpsFetch(
  input: string,
  init: RequestInit,
  addresses: readonly ResolvedLlmAddress[]
): Promise<Response> {
  const url = new URL(input);
  if (url.protocol !== "https:") throw new Error("UNSAFE_LLM_DESTINATION");
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  return new Promise<Response>((resolve, reject) => {
    // Keep the original URL so Node derives Host, TLS SNI, and certificate
    // verification from its hostname; only DNS lookup is replaced by pinned IPs.
    const request = httpsRequest(
      url,
      {
        method: init.method ?? "GET",
        headers,
        lookup: createPinnedLlmLookup(addresses),
        rejectUnauthorized: true,
        signal: init.signal ?? undefined
      },
      (response) => {
        const status = response.statusCode ?? 502;
        const hasNoBody = status === 204 || status === 205 || status === 304;
        const body = hasNoBody
          ? null
          : Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>;
        resolve(new Response(body, {
          status,
          headers: responseHeaders(response.headers)
        }));
      }
    );
    request.once("error", reject);
    if (typeof init.body === "string" || init.body instanceof Uint8Array) {
      request.end(init.body);
    } else if (init.body === undefined || init.body === null) {
      request.end();
    } else {
      request.destroy(new Error("Unsupported secure request body"));
    }
  });
}
