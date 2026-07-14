export function isoDateTime(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

export function workDateInTimeZone(
  value: Date | string,
  timeZone: string
): string {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const record = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${record.year}-${record.month}-${record.day}`;
}

function timeZoneOffsetMilliseconds(value: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(value);
  const record = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const representedAsUtc = Date.UTC(
    Number(record.year),
    Number(record.month) - 1,
    Number(record.day),
    Number(record.hour),
    Number(record.minute),
    Number(record.second)
  );
  const wholeSecondValue = Math.floor(value.getTime() / 1_000) * 1_000;
  return representedAsUtc - wholeSecondValue;
}

function startOfWorkDateUtc(workDate: string, timeZone: string): Date {
  const [year, month, day] = workDate.split("-").map(Number);
  const localMidnightAsUtc = Date.UTC(year, month - 1, day);
  let result = new Date(localMidnightAsUtc);
  for (let iteration = 0; iteration < 3; iteration += 1) {
    result = new Date(
      localMidnightAsUtc - timeZoneOffsetMilliseconds(result, timeZone)
    );
  }
  return result;
}

export function utcRangeForWorkDate(
  workDate: string,
  timeZone: string
): { from: Date; until: Date } {
  const [year, month, day] = workDate.split("-").map(Number);
  const nextDate = new Date(Date.UTC(year, month - 1, day + 1))
    .toISOString()
    .slice(0, 10);
  return {
    from: startOfWorkDateUtc(workDate, timeZone),
    until: startOfWorkDateUtc(nextDate, timeZone)
  };
}

export function projectDisplayName(
  normalizedGitRemote: string | null | undefined,
  repositoryRootName: string | null | undefined
): string {
  const fallback = repositoryRootName?.trim();
  if (fallback) return fallback.slice(0, 255);
  const remoteName = normalizedGitRemote
    ?.split("/")
    .filter(Boolean)
    .at(-1)
    ?.replace(/\.git$/i, "");
  return remoteName?.slice(0, 255) || "未分类项目";
}

export function inferEvidenceIntent(content: string): string | null {
  const normalized = content.toLocaleLowerCase();
  if (
    /(跨设备|设备).*(同步)|同步.*(幂等|设备|协议)|采集器.*(验收|用例|同步)/u.test(
      normalized
    )
  ) {
    return "sync-design";
  }
  if (/(日报|日结|工作总结|每日总结)/u.test(normalized)) {
    return "daily-summary";
  }
  if (/skill.*(优化|沉淀|审核)|(优化|沉淀|审核).*skill/u.test(normalized)) {
    return "skill-review";
  }
  return null;
}
