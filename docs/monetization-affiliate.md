# 给一个零后端的小工具挂上第一条联盟广告

> 记录一次真实落地：从选联盟、走申请、填税务表，到把一条静态文字链嵌进顶栏并发布上线。
> 文中标 **[实测]** 的是本项目某次具体运行拿到的读数，带日期；标「推断」的是估算，平台规则会变，动之前重测。

## 1. 起点：先看清自己有多少流量

动手之前先量基数，否则所有方案都是空谈。

**[实测] 2026-11-04 · Cloudflare 7 天统计**

| 指标 | 数值 | 折算 |
| --- | --- | --- |
| Unique Visitors | 386 | 约 55/天，月化约 1 650 |
| Total Requests | 2.28k | 人均 5.9 次 |
| Percent Cached | 49.23% | 正常 |
| Total Data Served | 23 MB | 人均约 60 KB |

一个关键判断来自最后两行：这是个要加载 wasm 解析器的应用，单次真实会话不可能只有 5.9 个请求、60 KB。
说明相当比例的「访客」是首屏即走、爬虫或误点。**真正进入应用的日活可能只有 25–30 人**，它直接决定广告曝光量的上限。

另一个前提是这个项目的硬约束：无后端、无第三方脚本、`audit:egress` 逐字扫描源码。这排除了所有
「贴一段 JS 自动轮换」的广告网络，只剩**静态文字链**这一条路。

## 2. 选平台：先排除掉进不去的

按「个人、小站、面向海外开发者」三个条件筛选。

| 平台 | 佣金 | Cookie / 结算 | 结论 |
| --- | --- | --- | --- |
| Educative | 每笔付费转化固定 20% | 30 天，每次点击重新计时；PayPal，每月 15 号结两个月前的单 | **选它**：意图最贴，规则最清晰 |
| DataCamp | 年订阅 15–20%，月订阅首月 50–80% | Impact 平台，最长 30 天，次月底前打款 | 备选：最容易过审 |
| Udemy / Coursera | 官网只写「competitive」，真实费率在后台 | Impact，24 小时归因 | 备选，费率不透明 |
| DigitalOcean | 10%/月，持续 12 个月 | 官方申请，月结 | 中：看调用图的人不是来买服务器的 |
| O'Reilly / Pluralsight | 个位数百分比，无续费佣金 | 第三方网络 | 不建议：佣金薄、决策周期长 |
| JetBrains | **无现金联盟计划** | 经销商需公司实体；Content Creators 要 2 000 粉丝，且只给一年 License + 折扣码 | 不建议：小站进不去 |

两条容易踩的认知：

1. **「口碑最好的」不等于「能拿到钱的」**。JetBrains 与这个工具的受众最匹配，但它的现行条款里没有对个人开放的现金佣金。
2. **Impact 是网络，不是品牌**。DataCamp、Udemy 这类把报名、发链、统计、结算托管在 impact.com 上。注册一个 publisher 账号可以同时申请多家，但佣金比例、cookie 时长、能不能过审，仍由品牌自己定。

## 3. 申请：材料准备比填表重要

**申请前先备齐四样**：站点地址、真实流量数字、能收美元的 PayPal、W-8BEN 需要的信息。

### 3.1 Educative 表单

三页：个人信息 → 推广渠道 → 受众规模。第三页是审核重点。

「How big is your audience?」要写**渠道 + 具体数字 + 受众是谁**，而不是只丢一个 UV：

> Website: 1 600 unique visitors/month (Cloudflare: 386 UV in the last 7 days). Free, open-source (MIT) browser tool that parses Python locally and draws function call graphs. Audience: Python developers and CS students reading unfamiliar codebases.

「Where will you promote?」只勾 Website。没有真实账号的社交渠道一律留空——审核会点进去看，空账号扣分多于加分。

开源仓库是这类小站唯一有说服力的「社群凭证」，GitHub 链接要比流量数字更显眼。

### 3.2 W-8BEN：中国个人怎么填

| 位置 | 填什么 |
| --- | --- |
| Part I Line 1 | 拼音全名 |
| Line 2 / Line 3 | China / China |
| Line 4 / Line 5 | 拼音居住地址；邮寄地址相同则勾 Same as line 4 |
| Line 6（US TIN） | **留空**，非美国税务居民 |
| Line 7（Foreign TIN） | 身份证号（中国个人的纳税人识别号） |
| Line 8（Reference） | 留空 |
| Line 9（DOB） | YYYY-MM-DD |
| Part II | 不申请税收协定就勾「None of the above」，Line 9/10 会被自动禁用 |
| Part III | 三条声明全勾，电子签名 + 打印姓名 |

默认按 **30%** 预扣美国所得税。中美税收协定理论上可降到 0%，但需要在首次到账后主动联系对方按协定调整——先跑通流程，别在第一笔钱之前折腾这个。

**不要写进仓库或文档的东西**：身份证号、银行卡号、PayPal 邮箱、家庭住址。它们只存在于 PandaDoc 表单和平台后台。

### 3.3 Impact：publisher 注册 + 网站验证

DataCamp 走 Impact，流程是：注册 publisher → 关联网站 → 验证归属 → Marketplace 准入 → 申请品牌。

卡在「验证归属」上花了整整一轮迭代，教训在 §5。

### 3.4 收款通道

PayPal 个人账号 + 国内储蓄卡。两个硬事实：

- 提现只能绑**借记卡/储蓄卡**，信用卡不能接收外汇入账。
- 五大行个人储蓄卡默认多币种，能收美元现汇；城商行不一定，绑之前打客服确认。
- 每次跨境入账都有 30% 预扣（首次）与 PayPal 提现费，按 $50 佣金算，实际到手约 $33。

## 4. 代码：一条做减法的实现

目标：不加任何依赖、不发任何第三方请求、不破坏现有 egress 审计。

### 4.1 配置驱动，`null` 即关闭

```tsx
export const PROMO: { href: string | null; text: string; tag: string } = {
  href: 'https://www.educative.io/unlimited?aff=XXXX',
  text: 'Deeper Python, one link away.',
  tag: 'Ad',
};
```

`href` 为 `null` 时整条不渲染，页面外观零变化。申请没批下来之前代码可以先合入，拿到链接后只改一个字符串。

**落地点选订阅页而不是课程页。** 后台默认给的两条链接都指向 `unlimited`，因为佣金只对订阅计
`20%`（课程单独购买不计），课程页最终也要再跳到同一个结账页。落地页多一跳，就多一处流失面；
而文案本身没写课程名，落地页与承诺不冲突。代价是「硬广感」更强 —— 这一条只能靠文案保持
「描述动作、不描述商品」来抵消。

### 4.2 位置：标题与按钮组之间

第一版放在标题行下方单独一条细条，理由是「不与那行 flexWrap 的按钮抢空间」。实际观感是「多了一条横幅」，
后来改到标题右侧、按钮组左侧，用 `flex: 1` + `justifyContent: 'center'` 吃掉中间空白：

```tsx
promoInline: {
  flex: 1,
  flexDirection: 'row',
  alignItems: 'center',
  justifyContent: 'center',
  gap: spacing.xs,
  minWidth: 0,
},
```

`minWidth: 0` 是窄屏的关键：空间不足时先压缩广告文字（`numberOfLines={1}` 出省略号），而不是把
「Select .py Files」挤走。

### 4.3 链接本身

web 上用原生 `<a>`，非 web 退化成不可点文本：

```tsx
<a
  href={PROMO.href}
  target="_blank"
  rel="sponsored noopener noreferrer"
  style={PROMO_LINK_WEB}
>
  <Text numberOfLines={1}>{PROMO.text}</Text>
</a>
```

- `rel="sponsored"`：告诉搜索引擎这是付费链接，面向海外是基本合规动作。
- `noopener noreferrer`：防止新页面拿到原窗口句柄。
- `display: flex` + `minWidth: 0` + `overflow: hidden`：让 `<a>` 在 flex 行内能正确截断。

**为什么不写 `onPress={() => window.open(...)}`**：`audit-egress` 按子串扫描源码，
`window.open` 是它的拦截词之一；而 `<a href>` 正好满足它「外链必须走 href」的规则。这是审计与实现互相约束后剩下的唯一形态。

### 4.4 测试与门禁

两条断言就够：`href` 为 null 时 `topbar-promo` 不存在；有值时是可点链接、`rel` 含 `sponsored`、带 `Ad` 角标。

每次改动必须跑完：`typecheck` → `lint --max-warnings=0` → `jest` → `audit:egress` → `export` → `smoke`。

## 5. 踩坑清单（全部实测）

### 5.1 审计扫注释，`window.opener` 被当成 `window.open`

第一次跑 `audit:egress` 报红，原因是我在注释里写了 `window.opener`——审计按子串匹配 `window.open`，注释也算。
把注释改成「原窗口句柄」后通过。**写注释时要考虑审计器的词表。**

### 5.2 Impact 的 meta 验证：`content` 为空

最初注入的是 `content` 与 `value` 双写的 meta。线上抓下来发现 `content=""`——apex 域名命中了 CDN 缓存，
返回的是旧 HTML。三个动作按顺序解决：

1. 改注入脚本，让 `content` / `value` 都变成可选字段，只输出品牌方给的那一个；
2. 改用 `pages.dev` 做验证地址（不走 zone 的缓存层）；
3. 仍失败后换验证方式：**content editing**，在 `</body>` 前插一段隐藏文本，一次通过。

结论：**第三方验证不要跟 CDN 缓存较劲，优先换一个绕过缓存的域名或换一种验证方式。**

### 5.3 `git push` 被拒：一个分支挂了多条 upstream

历史操作留下 `branch.main.remote` 与 `branch.main.merge` 各多条（`master` 和 `main` 混在一起），
`git push` 直接拒绝执行。修复：

```powershell
git config --unset-all branch.main.remote
git config --unset-all branch.main.merge
git branch --set-upstream-to=origin/main main
```

发布链路依赖 `main` 单分支，这类残留会让「改完自动发布」在第一步就断掉。

### 5.4 改完必须 purge 缓存

apex 域名与 `pages.dev` 不是同一条缓存路径。改了 HTML（注入 meta、调整顶栏）后，
`pages.dev` 立即生效，apex 可能还在返回旧版本。验收一律先在 `pages.dev` 上做，再 purge 主域名。

### 5.5 冒烟测试偶发超时，不要急着改代码

首次跑 smoke 有 1 条失败（拉取输入框的 CDP 时序），重跑 113/113 全过。判断标准：失败项与本次改动无关、
且历史全绿，先重跑一次再排查。

## 6. 收益：把预期压到地板上

用保守参数估一次（CTR 0.4%–1.5%，点击到付费 2%–5%，Educative 单笔佣金按 $40–50）：

| 场景 | CTR | 点击/月 | 成交/月 | 佣金/月 |
| --- | --- | --- | --- | --- |
| 保守 | 0.4% | 7 | 0.13 | 约 $5 |
| 中性 | 0.8% | 13 | 0.40 | 约 $18 |
| 乐观 | 1.5% | 25 | 1.24 | 约 $60 |

再把「有效访客约占一半」打进去，中性预期落到 **$8–12/月**，乐观不超过 $30。折算 RPM 约每千访客 $5，
与开发者向展示广告（$2–5）同量级。

三个会吃掉收入的现实因素：

1. **审核门槛**：Educative 偏好「有规模社群」的推广者，小站可能被拒；DataCamp 更容易先占位。
2. **结算延迟**：Educative 每月 15 号结两个月前的单，加上 PayPal 提现，前 2–3 个月账上可能是零。
3. **统计口径**：Cloudflare 免费版的 UV 是近似去重，且不含被拦截流量，可售曝光只会更低。

结论：这个量级不值得为广告改版式或做 A/B。按「零成本占位」处理，把精力放在流量上——
1 650 UV/月是噪声级别，翻十倍之前，优化广告位带来的绝对收益只有几美元。

## 7. 可复用清单

- [ ] 先量真实流量，区分「访问」与「真正进入应用的会话」
- [ ] 按「个人能否进、佣金是否透明、结算是否落地」筛平台，别按口碑
- [ ] 申请材料先备齐：站点、真实数字、PayPal、W-8BEN 所需信息
- [ ] W-8BEN：非美国税务居民，Line 6 留空，Line 7 填身份证号，Part II 勾 None of the above
- [ ] 代码用配置驱动，`href = null` 即关闭，先合入后填链接
- [ ] 只用 `<a href>` + `rel="sponsored noopener noreferrer"`，不引入任何脚本或像素
- [ ] 位置放标题与主操作之间，`flex: 1` 居中，`minWidth: 0` 保证窄屏先压缩自己
- [ ] 验收顺序：`pages.dev` → 主域名 purge → 联盟后台看点击
- [ ] 首月只盯一件事：Clicks 是否为 0。为 0 才需要排查链接形态

---

相关记录：发布机制见 `docs/ops-deployment.md`；外发约束见 `docs/adr/0006-url-pull-egress.md`。
