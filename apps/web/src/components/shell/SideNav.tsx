"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { Icon, type IconName } from "@/components/ui/Icon";

const navigation: Array<{ href: string; label: string; icon: IconName }> = [
  { href: "/", label: "工作台", icon: "dashboard" },
  { href: "/projects", label: "项目", icon: "folder" },
  { href: "/calendar", label: "日历", icon: "calendar" },
  { href: "/prompts", label: "Prompt 库", icon: "prompt" },
  { href: "/skills", label: "Skill 中心", icon: "skill" },
  { href: "/sync", label: "同步中心", icon: "sync" },
  { href: "/settings", label: "LLM 设置", icon: "settings" },
  { href: "/privacy", label: "数据与隐私", icon: "shield" }
];

export function SideNav() {
  const pathname = usePathname();

  return (
    <aside className="side-nav">
      <Link aria-label="AI 工作沉淀台首页" className="brand" href="/">
        <span className="brand__mark"><Icon name="skill" size={22} /></span>
        <span className="brand__copy">
          <strong>AI 工作沉淀台</strong>
          <small>Worklog</small>
        </span>
      </Link>
      <nav aria-label="主要导航" className="side-nav__links">
        {navigation.map((item) => {
          const active =
            item.href === "/"
              ? pathname === "/"
              : pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              aria-current={active ? "page" : undefined}
              className={`nav-link ${active ? "nav-link--active" : ""}`}
              href={item.href}
              key={item.href}
              title={item.label}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>
      <div className="side-nav__privacy">
        <Icon name="shield" size={18} />
        <span>仅同步脱敏内容</span>
      </div>
    </aside>
  );
}
