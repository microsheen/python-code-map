/**
 * 示例项目数据模块（issue #13）：清单完整性、随机抽取与星数缩写。
 *
 * 断言只走模块对外暴露的行为：抽到谁、清单里有什么、缩写读作什么；
 * 不测 JSON 解析细节，也不模拟模块内部实现。
 */
import {
  SUGGESTED_PROJECTS,
  formatStars,
  pickSuggestedProject,
} from '../src/data/suggestedProjects';

describe('示例项目清单', () => {
  it('内置清单是 100 个项目，共 267 条 Python 文件 URL', () => {
    expect(SUGGESTED_PROJECTS).toHaveLength(100);
    const total = SUGGESTED_PROJECTS.reduce((sum, project) => sum + project.urls.length, 0);
    expect(total).toBe(267);
  });

  it('每个项目的 URL 数量是 2–3 条、互不重复，且都是 github.com 的 .py blob 页面', () => {
    for (const project of SUGGESTED_PROJECTS) {
      expect(project.urls.length).toBeGreaterThanOrEqual(2);
      expect(project.urls.length).toBeLessThanOrEqual(3);
      // 同一 URL 填两行会变成两个批次拉同一个文件，清单里不允许
      expect(new Set(project.urls).size).toBe(project.urls.length);
      for (const url of project.urls) {
        expect(url).toMatch(/^https:\/\/github\.com\/[^/]+\/[^/]+\/blob\/[^/]+\/.+\.py$/);
      }
    }
  });

  it('每个项目都有可展示的身份字段与有限星数', () => {
    for (const project of SUGGESTED_PROJECTS) {
      expect(project.name.length).toBeGreaterThan(0);
      expect(project.fullName).toMatch(/^[^/]+\/[^/]+$/);
      // 清单元数据里允许 description 为空（kornia/kornia），卡片对空描述不渲染这一行
      expect(typeof project.description).toBe('string');
      expect(project.category.length).toBeGreaterThan(0);
      expect(Number.isFinite(project.stars)).toBe(true);
      expect(project.urls.length).toBeGreaterThan(0);
    }
  });
});

describe('pickSuggestedProject', () => {
  it('random 返回 0 时取清单第一个项目', () => {
    const picked = pickSuggestedProject({ random: () => 0 });
    expect(picked?.fullName).toBe('django/django');
  });

  it('random 逼近 1 时取清单最后一个项目，不会越界', () => {
    const picked = pickSuggestedProject({ random: () => 1 });
    expect(picked?.fullName).toBe('dateutil/dateutil');
  });

  it('清单为空时返回 null（卡片据此不渲染）', () => {
    expect(pickSuggestedProject({ projects: [], random: () => 0 })).toBeNull();
  });
});

describe('formatStars', () => {
  it('不足一千时原样输出', () => {
    expect(formatStars(999)).toBe('999');
  });

  it('千位档保留一位小数并去掉多余的 .0', () => {
    expect(formatStars(91489)).toBe('91.5k');
    expect(formatStars(1000)).toBe('1k');
  });

  it('百万档用 m', () => {
    expect(formatStars(1500000)).toBe('1.5m');
  });

  it('四舍五入到 1000k 时进位成 1m', () => {
    expect(formatStars(999999)).toBe('1m');
  });
});
