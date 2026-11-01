import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * `scripts/audit-egress.mjs` 的申报语义（issue #9 AC4）。
 *
 * audit 从「全局 --allow-token」改成「按文件 --allow-egress=<file>:<token>」的原因：全局放行
 * 拉取那一条 `fetch(` 会顺带把联系路径「没有任何请求原语」的保证一起放开。这里测的是**门本身**：
 * 申报只对声明的那个文件生效、没申报的文件照红、声明没人读是用法错。
 *
 * 用临时目录里的合成文件跑脚本，而不是拿真实源码当夹具：真实文件多一个 token 就让这条门变红，
 * 那时红的是源码，不是申报语义，信号会串。
 */
const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'audit-egress.mjs');

function run(cwd: string, args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-egress-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const FETCH = 'const r = fetch("https://example.invalid/x");\n';

describe('按文件申报 --allow-egress=<file>:<token>', () => {
  it('申报只对声明的那个文件生效：同 token 的另一个文件仍然红（exit 1）', () => {
    fs.writeFileSync(path.join(dir, 'a.ts'), FETCH);
    fs.writeFileSync(path.join(dir, 'b.ts'), FETCH);
    const r = run(dir, ['--files=a.ts,b.ts', '--allow-egress=a.ts:fetch(']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('FOUND');
    expect(r.out).toContain('ALLOWED');
  });

  it('申报覆盖该文件后 exit 0（放行是打印出来的，不是静默吞掉）', () => {
    fs.writeFileSync(path.join(dir, 'a.ts'), FETCH);
    const r = run(dir, ['--files=a.ts', '--allow-egress=a.ts:fetch(']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('ALLOWED');
    expect(r.out).toContain('OK');
  });

  it('没申报时同一文件红（exit 1）—— 申报不是装饰', () => {
    fs.writeFileSync(path.join(dir, 'a.ts'), FETCH);
    const r = run(dir, ['--files=a.ts']);
    expect(r.code).toBe(1);
  });

  it('申报给不在 --files 里的文件是用法错（exit 2，声明没人读等于没声明）', () => {
    fs.writeFileSync(path.join(dir, 'a.ts'), FETCH);
    const r = run(dir, ['--files=a.ts', '--allow-egress=b.ts:fetch(']);
    expect(r.code).toBe(2);
    expect(r.out).toContain('不在 --files 扫描范围内');
  });

  it('写成 <file>:<substr> 以外的形状是用法错（exit 2）', () => {
    fs.writeFileSync(path.join(dir, 'a.ts'), FETCH);
    const r = run(dir, ['--files=a.ts', '--allow-egress=a.ts']);
    expect(r.code).toBe(2);
    expect(r.out).toContain('--allow-egress 要写成');
  });
});

describe('package.json 的 audit:egress 配置（#9）', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const cmd = pkg.scripts['audit:egress'] ?? '';

  it('扫描范围里有拉取模块与两个拉取对话框，联系路径那三个文件仍在', () => {
    const files = (cmd.match(/--files=(\S+)/)?.[1] ?? '').split(',');
    expect(files).toEqual(
      expect.arrayContaining([
        'src/feedback/contact.ts',
        'src/components/FeedbackDialog.tsx',
        'src/platform/web/buildStamp.ts',
        'src/platform/web/pullFetch.ts',
        'src/pull/batch.ts',
        'src/pull/errors.ts',
        'src/pull/github.ts',
        'src/pull/githubFetch.ts',
        'src/pull/paths.ts',
        'src/pull/refresh.ts',
        'src/pull/transport.ts',
        'src/pull/urls.ts',
        'src/components/PullEntryDialog.tsx',
        'src/components/PullListingDialog.tsx',
        'src/components/TopBar.tsx',
      ]),
    );
  });

  /**
   * 上面那条 `arrayContaining` 只守「列出来的还在」，守不住「新增的没漏」：
   * 往 `src/pull/` 加一个模块而忘了进 `--files`，审计门会**静默不扫**它 —— 静默跳过的守卫比红灯更糟。
   * 所以这里反过来数目录：目录里有几个 .ts，扫描范围里就得有几个。
   */
  it('src/pull/ 下的每个模块都在扫描范围内（新增一个也不会漏扫）', () => {
    const files = (cmd.match(/--files=(\S+)/)?.[1] ?? '').split(',');
    const modules = fs.readdirSync(path.join(ROOT, 'src/pull')).filter((n) => n.endsWith('.ts'));
    expect(modules.length).toBeGreaterThan(5);
    for (const n of modules) expect(files).toContain('src/pull/' + n);
  });

  it('两处放行按文件申报，没有全局 --allow-token（否则联系路径的保证会被一起放开）', () => {
    expect(cmd).toContain('--allow-egress=src/platform/web/pullFetch.ts:fetch');
    expect(cmd).toContain('--allow-egress=src/components/TopBar.tsx:navigator.clipboard');
    expect(cmd).not.toContain('--allow-token=');
  });

  /**
   * npm 在 Linux 上把 script 交给 `sh -c`，未加引号的 `(` 会被当成子 shell 的开头 ——
   * CI 里报的是 `Syntax error: "(" unexpected`（exit 2），Windows 的 cmd.exe 却照传。
   * 所以申报的 substr 不能带 shell 元字符；这里钉住，免得下次又写回 `fetch(`。
   */
  it('申报串里没有未加引号的 shell 元字符（否则 Linux CI 会当成语法错误）', () => {
    expect(cmd).not.toMatch(/[()|&;<>]/);
  });

  it('保留了既有的 --require-href（外发路径应当长成用户点的链接）', () => {
    expect(cmd).toContain('--require-href');
  });
});
