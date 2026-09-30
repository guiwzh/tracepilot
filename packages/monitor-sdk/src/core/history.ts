/**
 * 包装 history.pushState / replaceState，调用之后通知 onChange。单页应用切换路由时不会触发 popstate，
 * 只能从这两个方法得知；需要知道路由变化的插件（面包屑、白屏检测）各自调用一次。
 *
 * 返回撤销包装的函数，规则与 NetworkPlugin 相同：只有全局引用仍是自己的包装时才还原。
 * 之后若有别的库（或另一个插件）又包了一层，直接还原会把它的包装一起抹掉；这时自己的包装留在调用链上，
 * 撤销后不再通知，只做透传。几个插件依次包装、按相反顺序撤销时，各自都能还原干净。
 */
export function watchHistory(
  onChange: (mechanism: 'pushState' | 'replaceState') => void,
): () => void {
  if (typeof history === 'undefined') return () => {};
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;
  let active = true;
  const wrappedPushState: History['pushState'] = function (this: History, ...args) {
    const result = originalPushState.apply(this, args);
    if (active) onChange('pushState');
    return result;
  };
  const wrappedReplaceState: History['replaceState'] = function (this: History, ...args) {
    const result = originalReplaceState.apply(this, args);
    if (active) onChange('replaceState');
    return result;
  };
  history.pushState = wrappedPushState;
  history.replaceState = wrappedReplaceState;
  return () => {
    active = false;
    if (history.pushState === wrappedPushState) history.pushState = originalPushState;
    if (history.replaceState === wrappedReplaceState) history.replaceState = originalReplaceState;
  };
}
