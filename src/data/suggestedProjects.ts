/*
 * 示例项目数据模块（issue #13）。
 *
 * 内置清单随包分发、静态 import，不新增任何网络请求；外发仍遵循 ADR-0006。
 * 对话框只消费这里窄化后的 SuggestedProject，原始 JSON 的字段改名/增删都收在这一个文件里。
 */
import rawProjects from '../../assets/data/famous_python_projects.json';

export interface SuggestedProject {
  /** 项目展示名（例如 Django） */
  name: string;
  /** 唯一身份 owner/repo，也是排除重复抽取的判据 */
  fullName: string;
  description: string;
  stars: number;
  category: string;
  /** 该项目的全部 Python 文件页面 URL，保持清单里的原始顺序 */
  urls: string[];
}

/** 清单里的 Python 文件条目类型：示例项目只认这一种 related_url */
const PYTHON_FILE = 'python_file';

export const SUGGESTED_PROJECTS: readonly SuggestedProject[] = rawProjects.projects.map((project) => ({
  name: project.name,
  fullName: project.full_name,
  description: project.description,
  stars: project.stargazers_count,
  category: project.category,
  urls: project.related_urls
    .filter((related) => related.type === PYTHON_FILE)
    .map((related) => related.url),
}));

export interface PickSuggestedProjectOptions {
  /** 随机源；默认 Math.random，测试注入固定值以获得确定结果 */
  random?: () => number;
  /** 候选清单；默认内置清单，测试用它覆盖“空清单”场景 */
  projects?: readonly SuggestedProject[];
}

/**
 * 抽一个示例项目。清单为空时返回 null —— 调用方据此不渲染卡片，不报错。
 */
export function pickSuggestedProject(options: PickSuggestedProjectOptions = {}): SuggestedProject | null {
  const { random = Math.random, projects = SUGGESTED_PROJECTS } = options;
  if (projects.length === 0) return null;
  const index = Math.floor(random() * projects.length);
  const bounded = Math.min(projects.length - 1, Math.max(0, index));
  return projects[bounded] ?? null;
}

function oneDecimal(value: number): string {
  const text = value.toFixed(1);
  return text.endsWith('.0') ? text.slice(0, -2) : text;
}

/** 星数缩写：不足一千原样、千位用 k、百万用 m（91.5k / 1.5m）。 */
export function formatStars(stars: number): string {
  if (stars < 1000) return String(stars);
  if (stars >= 1_000_000) return oneDecimal(stars / 1_000_000) + 'm';
  const thousands = oneDecimal(stars / 1000);
  // 999_999 这类会四舍五入到 1000k，顺势进位成 1m
  return Number(thousands) >= 1000 ? oneDecimal(stars / 1_000_000) + 'm' : thousands + 'k';
}
