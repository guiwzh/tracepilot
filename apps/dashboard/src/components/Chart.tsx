import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import {
  GridComponent,
  LegendComponent,
  TooltipComponent,
  type GridComponentOption,
  type LegendComponentOption,
  type TooltipComponentOption,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { BarSeriesOption, LineSeriesOption, PieSeriesOption } from 'echarts/charts';

// ECharts 按需注册图表、组件和 Canvas 渲染器，避免引入完整包的全部能力。
echarts.use([
  BarChart,
  LineChart,
  PieChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  CanvasRenderer,
]);

export type ChartOption = echarts.ComposeOption<
  | BarSeriesOption
  | LineSeriesOption
  | PieSeriesOption
  | GridComponentOption
  | TooltipComponentOption
  | LegendComponentOption
> & { xAxis?: unknown; yAxis?: unknown };

export function Chart({ option, height = 260 }: { option: ChartOption; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  // 实例句柄跨 effect 共享：实例生命周期与数据更新分成两个 effect，
  // 避免 option 引用变化（React Query 每次 refetch 都会产生新引用）触发整图销毁重建。
  const instanceRef = useRef<echarts.ECharts | null>(null);

  // effect 1：只在挂载/卸载时创建和销毁实例。
  useEffect(() => {
    const container = ref.current;
    if (!container) return;
    const chart = echarts.init(container, undefined, { renderer: 'canvas' });
    instanceRef.current = chart;
    // ResizeObserver 观察容器本身，除窗口缩放外也能响应侧边栏折叠、布局变化。
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(container);
    return () => {
      // dispose 会释放 Canvas、事件和 ECharts 内部引用，防止路由切换后内存泄漏。
      observer.disconnect();
      chart.dispose();
      instanceRef.current = null;
    };
  }, []);

  // effect 2：option 变化时只更新数据。默认合并模式复用已有系列，保留过渡动画；
  // 本项目各图表的 series 数量固定，不存在系列减少后残留的问题。
  useEffect(() => {
    instanceRef.current?.setOption(option);
  }, [option]);

  return <div ref={ref} style={{ height }} role="img" aria-label="Telemetry chart" />;
}
