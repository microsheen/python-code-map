/**
 * URL 与路径的共用小工具（issue #5 起被 urls / github 两处共用）。
 *
 * 单独一层是为了避免 urls 与 github 循环依赖：urls 判定分流时要知道「这是不是 .py/.pyi」，
 * github 推导页面形态时也要知道同一件事 —— 这个判据只留一份。
 */

/** 只认路径以 .py/.pyi 结尾；query/hash 不参与判断（?raw=1、#L10 都是常见写法）。 */
const PY_PATH_RE = /\.(py|pyi)$/i;

export function isPythonPath(path: string): boolean {
  return PY_PATH_RE.test(path);
}

/**
 * 真正会发出去的那个 URL：origin + pathname + search，**不含 hash**。
 *
 * 片段（#L10）是浏览器侧的东西，服务端永远收不到，所以它既不该出现在请求里，也不该参与
 * 批次身份 —— 否则同一条直链只差一个 #L3 就会被当成两个批次，「重复粘贴同一 URL 原位更新」
 * 那条验收标准就漏了。query 相反：?raw=1 会改变服务端返回什么，必须保留。
 */
export function wireUrl(u: URL): string {
  return u.origin + u.pathname + u.search;
}
