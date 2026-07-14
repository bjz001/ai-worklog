"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

import { Icon } from "@/components/ui/Icon";

export function TopToolbar() {
  const router = useRouter();
  const [query, setQuery] = useState("");

  const handleSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = query.trim();
    router.push(value ? `/prompts?q=${encodeURIComponent(value)}` : "/prompts");
  };

  return (
    <header className="top-toolbar">
      <form className="global-search" onSubmit={handleSearch} role="search">
        <Icon name="search" />
        <label className="sr-only" htmlFor="global-search">搜索所有 Prompt</label>
        <input
          id="global-search"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索 Prompt、项目或标签"
          type="search"
          value={query}
        />
      </form>
      <div className="top-toolbar__actions">
        <span className="privacy-indicator">
          <Icon name="shield" size={18} />
          <span>脱敏模式</span>
        </span>
        <Link className="button button--primary" href="/sync#run-now">
          <Icon name="sync" />
          <span>立即同步</span>
        </Link>
      </div>
    </header>
  );
}
