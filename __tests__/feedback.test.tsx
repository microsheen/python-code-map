/**
 * 反馈渠道的契约测试。
 *
 * 这份文件里最重要的一条是「金丝雀」：它证明白名单不是文档里的一句话，而是结构上的
 * 不可能 —— 文件名、函数名、告警原文、代码原文，无论调用方怎么传，都进不了对外文本与 href。
 * 其余各条钉住：恰好 8 个字段、值全是标量、幂等、脏值退化、长度预算、URL 形状、
 * 面板渲染与草稿丢弃、入口不被 busy 关掉、联系路径只可能长在一个文件里。
 *
 * 组件用 @testing-library/react 的 fireEvent（理由同 appFlow.test.tsx 头注：RNW 下
 * .press 会撞 "Text strings must be rendered within a <Text>" 不变量）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { FeedbackDialog } from '../src/components/FeedbackDialog';
import type { FeedbackDiag } from '../src/components/FeedbackDialog';
import { TopBar } from '../src/components/TopBar';
import { makePyFile } from '../src/parser/analyze';
import {
  CONTACT_EMAIL,
  DIAG_FIELD_NAMES,
  DIAG_MAX_CHARS,
  ISSUE_TITLE,
  REPO_ISSUES_URL,
  buildDiagnosticsText,
  collectDiagnostics,
  issuesHrefFor,
  issuesUrl,
  mailtoUrl,
  reportBody,
} from '../src/feedback/contact';
import type { DiagFields } from '../src/feedback/contact';
import { NO_SELECTION, useAppStore } from '../src/state/store';

const EXPECTED_FIELDS = [
  'build',
  'ua',
  'files',
  'funcs',
  'edges',
  'unresolved',
  'warnings',
  'persisted',
];

/** 全 unknown/0 的那一块：脏输入的合法退路。 */
const EMPTY_DIAG_TEXT = EXPECTED_FIELDS.map((f) =>
  f === 'build' || f === 'ua' || f === 'persisted' ? f + '=unknown' : f + '=0'
).join('\n');

/** 显眼的秘密。任何一枚出现在对外输出里，都说明白名单漏了。 */
const NEEDLES = [
  'CM_CANARY_文件夹路径',
  'CM_CANARY_函数名',
  'CM_CANARY_告警文本',
  'CM_CANARY_代码原文',
  '非ASCII也一起埋_✓',
];

/** 一个「粗心调用方」：把整个应用状态原样端过来，连白名单外的字段一起给。 */
function carelessSource(): Record<string, unknown> {
  return {
    build: 'entry-abc12345',
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0',
    // 白名单内的字段：给数组、给对象，只该留下长度
    files: ['CM_CANARY_文件夹路径/main.py', 'pkg/CM_CANARY_文件夹路径/main.py'],
    funcs: ['CM_CANARY_函数名'],
    edges: [{ src: 'CM_CANARY_文件夹路径/main.py', dst: 'CM_CANARY_函数名' }],
    unresolved: ['CM_CANARY_函数名'],
    warnings: ['CM_CANARY_告警文本', 'def CM_CANARY_代码原文():', '非ASCII也一起埋_✓'],
    persisted: true,
    // 白名单外的字段：必须整体消失
    title: 'def CM_CANARY_代码原文():',
    name: 'CM_CANARY_文件夹路径/main.py',
    path: 'CM_CANARY_文件夹路径/main.py',
    activeFile: 'CM_CANARY_文件夹路径/main.py',
    error: 'CM_CANARY_告警文本',
    content: 'def CM_CANARY_代码原文():\n    return "注释里的秘密"  # 非ASCII也一起埋_✓',
  };
}

function assertNoNeedle(text: string, where: string): void {
  for (const needle of NEEDLES) {
    expect({ where, hasNeedle: text.includes(needle) }).toEqual({ where, hasNeedle: false });
  }
}

describe('金丝雀：白名单在结构上挡住用户内容', () => {
  it('诊断文本 / Issues href / 邮件 href 里，一枚金丝雀都不出现', () => {
    const text = buildDiagnosticsText(carelessSource());
    assertNoNeedle(text, 'buildDiagnosticsText');
    assertNoNeedle(issuesUrl(ISSUE_TITLE, reportBody(text)), 'issuesUrl');
    const mail = mailtoUrl('s', reportBody(text));
    if (mail !== null) assertNoNeedle(mail, 'mailtoUrl');
    // 计数照常成立：数组被收成数字，而不是被 String() 原样搬出去
    expect(text).toContain('files=2');
    expect(text).toContain('funcs=1');
    expect(text).toContain('warnings=3');
    expect(text).toContain('persisted=yes');
    expect(text).toContain('build=entry-abc12345');
  });

  it('输出里不长出 name= / path= / title= 这类字段痕迹', () => {
    const lines = buildDiagnosticsText(carelessSource()).split('\n');
    for (const forged of ['name=', 'path=', 'title=', 'content=', 'activeFile=', 'error=']) {
      expect(lines.some((l) => l.indexOf(forged) === 0)).toBe(false);
    }
  });

  it('渲染路径真正走过的 issuesHrefFor 也带不出去秘密', () => {
    assertNoNeedle(issuesHrefFor(buildDiagnosticsText(carelessSource())), 'issuesHrefFor');
  });
});

describe('白名单与形状', () => {
  it('字段名冻结，逐字等于那 8 个、顺序一致', () => {
    expect(Object.isFrozen(DIAG_FIELD_NAMES)).toBe(true);
    expect([...DIAG_FIELD_NAMES]).toEqual(EXPECTED_FIELDS);
  });

  it('恰好 8 行、第 i 行是第 i 个字段、值前只有一个 =', () => {
    const lines = buildDiagnosticsText({ ua: 'Chrome' }).split('\n');
    expect(lines).toHaveLength(EXPECTED_FIELDS.length);
    lines.forEach((line, i) => {
      expect(line.startsWith(EXPECTED_FIELDS[i] + '=')).toBe(true);
      expect(line.split('=').length).toBe(2);
    });
  });

  it('collectDiagnostics 的每个值都是标量', () => {
    const fields = collectDiagnostics(carelessSource());
    for (const name of DIAG_FIELD_NAMES) {
      const value = fields[name];
      expect(typeof value === 'string' || typeof value === 'number').toBe(true);
      expect(Array.isArray(value)).toBe(false);
    }
  });

  it('幂等：收口后的字段再收一遍，输出逐字节不变', () => {
    const once = buildDiagnosticsText(carelessSource());
    // 渲染路径上真正发生的形状：TopBar 拼的原始值每帧都重新过一遍收口
    expect(buildDiagnosticsText(collectDiagnostics(carelessSource()))).toBe(once);
    const fields = collectDiagnostics(carelessSource());
    expect(buildDiagnosticsText(collectDiagnostics(fields))).toBe(once);
    expect(buildDiagnosticsText(fields)).toBe(once);
  });

  it('文本不是输入形状：回灌上一轮的 key=value 串会诚实退化成 unknown/0', () => {
    // 类型系统拦得住这种调用，这里刻意绕过去问运行时的兜底：面板把 primitives 传进来，
    // 从不回灌文本（用户手改的 draft 直接进 href）。传错形状不能静默变成半对，
    // 而是整块退回 unknown/0 —— 一眼就能看出调用方写错了。
    const once = buildDiagnosticsText(carelessSource());
    const back = buildDiagnosticsText(once as unknown as DiagFields);
    expect(back).toBe(EMPTY_DIAG_TEXT);
  });
});

describe('脏输入退化', () => {
  it('undefined / {} / 类型全错：仍然 8 行，全是 unknown 或 0', () => {
    expect(buildDiagnosticsText(undefined)).toBe(EMPTY_DIAG_TEXT);
    expect(buildDiagnosticsText({})).toBe(EMPTY_DIAG_TEXT);
    expect(buildDiagnosticsText(null)).toBe(EMPTY_DIAG_TEXT);
    expect(
      buildDiagnosticsText({
        build: 42,
        ua: {},
        files: {},
        funcs: 'x',
        edges: true,
        unresolved: null,
        warnings: Number.NaN,
        persisted: 'true',
      })
    ).toBe(EMPTY_DIAG_TEXT);
  });

  it("persisted:'true'（字符串）不许被强制转换成 yes —— 未转换才是调用方写错的信号", () => {
    expect(collectDiagnostics({ persisted: 'true' }).persisted).toBe('unknown');
    expect(collectDiagnostics({ persisted: 'yes' }).persisted).toBe('yes');
    expect(collectDiagnostics({ persisted: false }).persisted).toBe('no');
    expect(collectDiagnostics({ persisted: 1 }).persisted).toBe('unknown');
  });

  it('负数退成 0，不把 -5 写进对外文本', () => {
    const fields = collectDiagnostics({ funcs: -5, edges: -0.5, files: -1 });
    expect(fields.funcs).toBe(0);
    expect(fields.edges).toBe(0);
    expect(fields.files).toBe(0);
  });

  it('UA 里的 NUL / 0x1f / 回车换行被剥掉：换行会伪造出一行假字段', () => {
    const text = buildDiagnosticsText({ ua: 'a\u0000b\u001fc\r\nd' });
    const lines = text.split('\n');
    expect(lines).toHaveLength(EXPECTED_FIELDS.length);
    const uaLine = lines.find((l) => l.indexOf('ua=') === 0) ?? '';
    expect(uaLine.indexOf('\u0000')).toBe(-1);
    expect(uaLine.indexOf('\u001f')).toBe(-1);
    expect(uaLine.indexOf('\r')).toBe(-1);
    expect(uaLine).toBe('ua=abc d');
  });
});

describe('长度预算', () => {
  it('脏输入全打满时总长仍 <= DIAG_MAX_CHARS：预算由每字段上限结构性保证', () => {
    const filled = buildDiagnosticsText({
      build: 'B'.repeat(5000),
      ua: 'X'.repeat(5000),
      files: Array.from({ length: 9999 }, () => 1),
      funcs: Number.MAX_VALUE,
      edges: 1.5e21,
      unresolved: [1, 2, 3],
      warnings: Number.MAX_SAFE_INTEGER,
      persisted: 'yes',
    });
    expect(filled.length).toBeLessThanOrEqual(DIAG_MAX_CHARS);
    expect(filled.split('\n')).toHaveLength(EXPECTED_FIELDS.length);
    // ua 被自己的字段上限截到 160，所以 600 是下限而不是天花板
    expect((filled.split('\n')[1] ?? '').length).toBeLessThanOrEqual(3 + 160);
  });

  it('超出预算时只截 ua 的尾巴：行数仍是 8、每行仍是完整 key=value、绝不整行丢弃', () => {
    const text = buildDiagnosticsText({ ua: 'X'.repeat(400), warnings: 12345 }, 120);
    expect(text.length).toBeLessThanOrEqual(120);
    const lines = text.split('\n');
    expect(lines).toHaveLength(EXPECTED_FIELDS.length);
    lines.forEach((line, i) => expect(line.startsWith(EXPECTED_FIELDS[i] + '=')).toBe(true));
    expect((lines[1] ?? '').endsWith('...')).toBe(true);
    // 牺牲的只有 ua：其它 7 行与不截预算时逐字节相同
    const untouched = buildDiagnosticsText({ ua: 'X'.repeat(400), warnings: 12345 }, 600).split(
      '\n'
    );
    lines.forEach((line, i) => {
      if (EXPECTED_FIELDS[i] !== 'ua') expect(line).toBe(untouched[i]);
    });
  });
});

describe('URL 形状', () => {
  it('Issues href = 仓库地址 + ?title=&body=，正文里的 & 编成 %26、空格编成 %20', () => {
    const href = issuesUrl('a b', 'x & y\nZ');
    expect(href.startsWith(REPO_ISSUES_URL + '?')).toBe(true);
    expect(href).toContain('title=a%20b');
    expect(href).toContain('x%20%26%20y');
    expect(href).not.toContain('\n');
    expect(href).not.toContain('+');
    expect((href.split('?')[1] ?? '').split('&')).toHaveLength(2);
  });

  it('门控关闭时 mailtoUrl 返回 null（这是整条邮件路径唯一的开关）', () => {
    if (CONTACT_EMAIL === null) expect(mailtoUrl('s', 'b')).toBeNull();
    else expect(mailtoUrl('s', 'b')).toBe('mailto:' + CONTACT_EMAIL + '?subject=s&body=b');
  });

  it('诊断块绝不进 Issues 标题（标题会出现在列表、通知与搜索里）', () => {
    const query = issuesHrefFor(buildDiagnosticsText(carelessSource())).split('?')[1] ?? '';
    const title = query.split('&')[0] ?? '';
    expect(decodeURIComponent(title.replace('title=', ''))).toBe(ISSUE_TITLE);
    expect(title).not.toContain('build=');
  });
});

const ALWAYS_ANCHORS = [
  'feedback-dialog',
  'feedback-intro',
  'feedback-lines',
  'feedback-issues-link',
  'feedback-diag-label',
  'feedback-diag',
  'feedback-close',
];
const MAIL_ANCHORS = [
  'feedback-email-label',
  'feedback-email',
  'feedback-mail-link',
  'feedback-hint',
];
const ALL_ANCHORS = [...ALWAYS_ANCHORS, ...MAIL_ANCHORS];

const DIAG: FeedbackDiag = { files: 3, funcs: 45, edges: 49, unresolved: 26, warnings: 0 };

function panelAnchors(): (HTMLAnchorElement & { testid: string | null })[] {
  const dialog = screen.getByTestId('feedback-dialog');
  return Array.from(dialog.querySelectorAll('a')).map((a) =>
    Object.assign(a, { testid: a.getAttribute('data-testid') })
  );
}

function diagValue(): string {
  return (screen.getByTestId('feedback-diag') as HTMLTextAreaElement).value;
}

/**
 * 把 hasSession 的异步回包冲干净。面板打开时会在 effect 里发这个 promise，
 * 同步用例不等它就结束的话，setState 落在测试之外，React 报 act 警告 ——
 * 噪音会淹没真正那条红灯，所以每个「渲染了打开态面板」的用例都冲一次。
 */
const flushPanel = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

afterEach(cleanup);

describe('面板渲染', () => {
  it('open=false 时什么都不渲染（不留下隐藏的 href）', () => {
    render(<FeedbackDialog open={false} onClose={() => {}} diag={DIAG} />);
    expect(screen.queryByTestId('feedback-dialog')).toBeNull();
    expect(document.querySelectorAll('a')).toHaveLength(0);
  });

  it('锚点齐备（门控开启=11 个，关闭=7 个）、<a> 数 == 门控期望、零 <li>', async () => {
    render(<FeedbackDialog open onClose={() => {}} diag={DIAG} />);
    const gated = CONTACT_EMAIL === null;
    for (const id of ALWAYS_ANCHORS) expect(screen.queryByTestId(id)).not.toBeNull();
    for (const id of MAIL_ANCHORS) {
      expect(gated ? screen.queryByTestId(id) === null : screen.queryByTestId(id) !== null).toBe(
        true
      );
    }
    const present = ALL_ANCHORS.filter((id) => screen.queryByTestId(id) !== null).length;
    expect(present).toBe(gated ? ALWAYS_ANCHORS.length : ALL_ANCHORS.length);
    expect(panelAnchors()).toHaveLength(gated ? 1 : 2);
    expect(screen.getByTestId('feedback-dialog').querySelectorAll('li')).toHaveLength(0);
    const issues = screen.getByTestId('feedback-issues-link');
    expect(issues.getAttribute('target')).toBe('_blank');
    expect(issues.getAttribute('rel')).toBe('noopener noreferrer');
    if (!gated) {
      const mail = screen.getByTestId('feedback-mail-link');
      expect(mail.getAttribute('target')).toBeNull();
      expect(mail.getAttribute('rel')).toBeNull();
      expect(screen.getByTestId('feedback-email').textContent).toBe(CONTACT_EMAIL);
    }
    await waitFor(() => expect(diagValue()).toContain('persisted=no'));
  });

  it('改诊断块后，每一枚对外链接都带上改后的文本', async () => {
    render(<FeedbackDialog open onClose={() => {}} diag={DIAG} />);
    await flushPanel();
    fireEvent.change(screen.getByTestId('feedback-diag'), {
      target: { value: '手改过的内容 CM_USER_NOTE' },
    });
    for (const anchor of panelAnchors()) {
      expect(decodeURIComponent(anchor.getAttribute('href') ?? '')).toContain(
        '手改过的内容 CM_USER_NOTE'
      );
    }
  });

  it('关闭再打开：草稿丢弃、回到自动值（render 期清状态，不是 useEffect）', async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <button type="button" data-testid="h-open" onClick={() => setOpen(true)}>
            open
          </button>
          <button type="button" data-testid="h-close" onClick={() => setOpen(false)}>
            close
          </button>
          <FeedbackDialog open={open} onClose={() => setOpen(false)} diag={DIAG} />
        </div>
      );
    }
    render(<Harness />);
    fireEvent.click(screen.getByTestId('h-open'));
    await waitFor(() => expect(diagValue()).toContain('persisted=no'));
    fireEvent.change(screen.getByTestId('feedback-diag'), {
      target: { value: 'CM_DRAFT_残留草稿' },
    });
    fireEvent.click(screen.getByTestId('h-close'));
    expect(screen.queryByTestId('feedback-dialog')).toBeNull();
    fireEvent.click(screen.getByTestId('h-open'));
    expect(diagValue()).not.toContain('CM_DRAFT_残留草稿');
    expect((diagValue().split('\n')[0] ?? '').startsWith('build=')).toBe(true);
    await flushPanel();
  });

  it('点关闭钮、点遮罩、Esc 都关闭；点面板内部不关闭', async () => {
    const onClose = jest.fn();
    const { container } = render(<FeedbackDialog open onClose={onClose} diag={DIAG} />);
    await flushPanel();
    const overlay = container.firstElementChild as HTMLElement;
    fireEvent.click(screen.getByTestId('feedback-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByTestId('feedback-diag'));
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('诊断数字来自 props，面板不读 store：store 清空也照样渲染（降级态可用）', async () => {
    useAppStore.setState({ files: [], graph: null, warnings: [], status: 'idle' });
    render(<FeedbackDialog open onClose={() => {}} diag={DIAG} />);
    await flushPanel();
    expect(diagValue()).toContain('files=3');
    expect(diagValue()).toContain('funcs=45');
    expect(diagValue()).toContain('edges=49');
    expect(diagValue()).toContain('unresolved=26');
  });
});

describe('顶栏入口', () => {
  const disabledMarker = (el: HTMLElement) =>
    el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled');

  it('解析中（busy）也必须能点：它是只读入口，故意不 gate', async () => {
    act(() => {
      useAppStore.setState({ status: 'parsing', selection: NO_SELECTION, files: [], graph: null });
    });
    render(<TopBar />);
    expect(disabledMarker(screen.getByTestId('topbar-upload') as HTMLElement)).toBe(true);
    expect(disabledMarker(screen.getByTestId('topbar-feedback') as HTMLElement)).toBe(false);
    fireEvent.click(screen.getByTestId('topbar-feedback'));
    expect(screen.queryByTestId('feedback-dialog')).not.toBeNull();
    await flushPanel();
  });

  it('Feedback 排在 scope 段之后、Clear 之前：Clear 出现/消失不让它跳位', () => {
    const orderOf = () =>
      Array.from(document.querySelectorAll('[data-testid]'))
        .map((el) => String(el.getAttribute('data-testid')))
        .filter((t) =>
          ['topbar-upload', 'topbar-scope', 'topbar-feedback', 'topbar-reset'].includes(t)
        );
    act(() => {
      useAppStore.setState({
        status: 'idle',
        files: [],
        graph: null,
        warnings: [],
        selection: NO_SELECTION,
      });
    });
    render(<TopBar />);
    expect(orderOf()).toEqual(['topbar-upload', 'topbar-scope', 'topbar-feedback']);
    act(() => {
      useAppStore.setState({
        files: [makePyFile('a.py', 'a.py', 'def f():\n    pass\n')],
        status: 'ready',
      });
    });
    expect(orderOf()).toEqual(['topbar-upload', 'topbar-scope', 'topbar-feedback', 'topbar-reset']);
  });
});

describe('反向不变量：不许长出第二条联系路径', () => {
  const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

  function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return /\.tsx?$/.test(entry.name) ? [full] : [];
    });
  }

  it('mailto: 只可能出现在 src/feedback/contact.ts', () => {
    const root = path.resolve(__dirname, '..', 'src');
    const files = sourceFiles(root);
    expect(files.length).toBeGreaterThan(10);
    const mailto = files
      .filter((f) => fs.readFileSync(f, 'utf8').includes('mailto:'))
      .map((f) => path.relative(root, f).split(path.sep).join('/'));
    expect(mailto).toEqual(['feedback/contact.ts']);
  });

  it('门控关闭期间 src/ 里零邮箱字面量（启用后只允许那一个常量）', () => {
    const root = path.resolve(__dirname, '..', 'src');
    const found: string[] = [];
    for (const f of sourceFiles(root)) {
      for (const m of fs.readFileSync(f, 'utf8').matchAll(EMAIL_RE)) {
        found.push(path.relative(root, f) + ': ' + m[0]);
      }
    }
    expect(
      CONTACT_EMAIL === null ? found : found.filter((x) => !x.includes(CONTACT_EMAIL ?? ''))
    ).toEqual([]);
  });
});
