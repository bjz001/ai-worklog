import { redirect } from "next/navigation";

export const metadata = { title: "Agent 轨迹" };

type SearchParams = Record<string, string | string[] | undefined>;

export default async function PromptsPage({
  searchParams
}: {
  searchParams: Promise<SearchParams>;
}) {
  const values = await searchParams;
  const next = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (Array.isArray(value)) value.forEach((item) => next.append(key, item));
    else if (value !== undefined) next.set(key, value);
  }
  redirect(next.size > 0 ? `/runs?${next.toString()}` : "/runs");
}
