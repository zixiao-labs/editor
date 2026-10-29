# 外部文本存储与只读渲染接缝

状态：根入口的 `createTextSource`、`textSourceFromHead` 已实现；仅渲染的 shaping/view
入口仍为类型契约，尚无可调用的 GPU 渲染器。本文不把有界读取验收当作实际绘制验收。

## 两种接入，不同责任

| 产品需求 | 接入 | 不要求 |
| --- | --- | --- |
| gap buffer 快速预览、产品自有文本只读展示 | `createTextSource` | history、writer、稳定位置、rope/SumTree |
| 产品自有完整历史/协作算法 | `defineHistoryBackend` | 默认 FugueMax 的节点/寄存器格式 |
| 已有任意兼容后端的 head，供同一只读布局接口消费 | `textSourceFromHead` | 复制到第二份可写 buffer |

默认完整后端是未来开箱即用选项，不垄断文本存储。只读文本源不是降级的假 HistoryStore：
它没有 commit、undo、因果 revision、presence 或位置保留承诺。

## 产品 gap buffer

下面的 `buffer` 是产品对象，不是库内置的 gap buffer。`version` 必须在每次修改后变化，
不能用当前字符串或长度充当版本；先改后改回也必须使旧 lease 失效。

```ts
import { createTextSource } from "@zixiao-labs/editor";

const source = createTextSource({
  snapshot() {
    const version = buffer.version;
    return {
      kind: "versioned",
      lengthUtf16: buffer.lengthUtf16,
      isCurrent: () => buffer.version === version,
      readUtf16: (start, end) => buffer.readUtf16(start, end),
      dispose() {}, // 释放产品 read lock/lease；不能销毁 buffer
    };
  },
  onChange: (listener) => buffer.onChange(listener),
});
```

原始 `readUtf16` 必须返回精确半开窗口，包含任意 UTF-16 单元；边界探测可能只读 surrogate
的一半。公开 `TextReadSnapshot` 会检查端点、孤立 surrogate、范围和返回长度；
合法结果保留 emoji、CRLF 和原始文本。检查不扫描整个 buffer，非法数据不能靠此入口
获得全篇已验证的保证。原始存储无安全并发读取能力时，应取得锁或提供不可变快照。

可变 lease 的每次读取、边界构造前后都会检查有效性；变化报 `STALE_TEXT_VIEW`，
不会交出部分新旧混合文本。`isCurrent` 必须无副作用且同步、能在整个 lease 期间使用。
通知需要在产品发布变更后送出；它不能代替可变 lease 的版本检测。

如果产品本来就有 COW/持久快照，返回 `kind: "snapshot"`，让 lease 闭包持有那份不可变
版本并在 dispose 释放。它在后续变更后仍可读。可选 `isCurrent()` 可在异步通知前判断
latestness，不会让持久旧文本自动变成 stale。

## 使用 read 与异步布局

```ts
const read = source.snapshot();
try {
  const range = read.rangeUtf16(startUtf16, endUtf16); // 产品所需窗口，端点必须为 scalar 边界
  const text = read.read(range);
  read.assertValid();
  if (source.isCurrent(read)) publish(text);
} finally {
  read.dispose();
}
```

`TextReadVersion` 是每份 read 的本地 opaque identity，不是同步版本。即使两个 read
来自同一 buffer 且文本相等，其 range 也不能互换；否则报 `WRONG_TEXT_VIEW`。
point/range 不能 cast 成历史坐标或稳定位置。`assertValid` 与 `isCurrent` 含义不同：
持久旧 read 可以读取，但不可发布成当前帧；可变旧 read 则连读取都拒绝。

未来 `LayoutEngine.layoutText` 接受这份 read，glyph ranges/hits 携带 read version。
异步完成后 view 还必须确认 source 未替换、read 仍 current、layout generation
仍匹配。`onChange` 只是 microtask 合并失效通知，不保证逐编辑回调，不携带历史。
监听器异常交给 `onError`；未提供 sink 时异步暴露，不静默吞掉。

source 借用 product provider，只释放自己的订阅；read 释放自己的 lease。
活动 read 使 source dispose 报 `RESOURCE_IN_USE`；释放完再 dispose source。
库不替产品关闭 buffer，也不隐含级联销毁其他资源。

## 完整模式与切换

```ts
import { textSourceFromHead } from "@zixiao-labs/editor";

const fullSource = textSourceFromHead(head, document);
// 未来只读 GPU view 契约：view.setSource(fullSource)
// 当前还没有可调用的 mountVgpuTextView 或实际 view。
```

adapter 使用该 head 的 snapshot 和 `readUtf16`，不展平或复制整篇 rope。
history read 的 scalar 边界检查仍生效；adapter 只在 raw 探测端点切开 surrogate 时
扩展至相邻完整 scalar，再对这个小窗口裁剪。head checkpoint stamp 检测同步编辑/checkout，
不等排队的变更事件才发现旧布局失效。旧历史 snapshot 仍可读，直到显式释放。

快速→完整由产品显式决定：保留原数据、导入为一个新 root，或通过产品已有迁移机制恢复
历史。把当前字符串设为新 root 不会凭空恢复过去的编辑。完整→快速同样明确捕获文本/
存储版本，再替换 source；不把旧 read offsets 当作新 history revision 的位置。
取消/丢弃旧异步布局并释放 read 后，才能关闭旧 source。`setSource` 不能销毁任一数据 owner。

## 实际证据与未完成项

- 测试使用真实双侧 UTF-16 gap buffer，跨 gap 有界读取、100k 文本局部读、Unicode/CRLF；
- mutable ABA 与读中无通知变更拒绝、旧 persistent read 保留、异 range 拒绝、通知合并；
- native head 的局部读禁止展平大 rope，含 emoji 相邻边界，立即检查新 checkpoint；
- 显式 fast/full source 替换，不转换旧坐标，不销毁两个 owner；
- ES-only 包名 consumer、Node 无 DOM/网络 smoke、只读坐标不能进入编辑接口的类型负例。

尚无字体塑形、WebGPU 绘制/设备丢失恢复、浏览器输入/IME、模式迁移 UI、真实替代历史引擎
或完整历史性能基准。上述端口不承担这些未实现能力。
