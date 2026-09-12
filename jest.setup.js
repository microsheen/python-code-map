// 组件测试所需的最小 web 全局量
if (typeof globalThis.matchMedia !== 'function') {
  globalThis.matchMedia = () => ({
    matches: false,
    media: '',
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() {
      return false;
    },
  });
}
if (typeof globalThis.ResizeObserver !== 'function') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (typeof globalThis.structuredClone !== 'function') {
  // @dagrejs/dagre 在排序阶段用到 structuredClone，jsdom 测试环境没有这个全局量
  const v8 = require('node:v8');
  globalThis.structuredClone = (value) => v8.deserialize(v8.serialize(value));
}
