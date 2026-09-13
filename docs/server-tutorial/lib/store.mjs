/**
 * 练习用的内存数据层。
 *
 * 数据身份（project / issue / release 的 id）与 SQL 教程完全一致，
 * 所以两套练习讲的是同一个系统：那边练「怎么把数据查出来」，
 * 这里练「怎么把数据经过 HTTP 安全地收进来、发出去」。
 *
 * 为什么用内存对象而不是 SQLite：这套教程的学习目标是 HTTP 与 Node 运行时，
 * 不是再练一遍 SQL。去掉数据库依赖后整套练习零依赖、零启动 flag。
 * 真实项目里这一层就是 apps/server/src/services/queries.ts，
 * 每个函数下面都注明了对应的真实 SQL。
 */

/** 固定基准时间，保证任何人任何时候运行都得到同一份数据。 */
const BASE = Date.UTC(2026, 2, 2, 9, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const PROJECTS = [
  { id: 'demo-project', name: 'Checkout Web', dsnKey: 'demo-dsn-key', createdAt: BASE - 90 * DAY },
  {
    id: 'mobile-web',
    name: 'Mobile Storefront',
    dsnKey: 'mobile-dsn-key',
    createdAt: BASE - 60 * DAY,
  },
  // 和 SQL 教程一样，留一个没有任何 Issue 的项目。
  {
    id: 'legacy-admin',
    name: 'Legacy Admin',
    dsnKey: 'legacy-dsn-key',
    createdAt: BASE - 400 * DAY,
  },
];

const ISSUES = [
  {
    id: 'iss-hydrate',
    projectId: 'demo-project',
    title: 'CheckoutStateError: Checkout state failed to hydrate',
    status: 'unresolved',
    level: 'error',
    firstSeenAt: BASE - 9 * DAY,
    lastSeenAt: BASE - 1 * HOUR,
    eventCount: 24,
    userCount: 9,
  },
  {
    id: 'iss-promotion',
    projectId: 'demo-project',
    title: 'PromotionError: Promotion response contained an invalid discount',
    status: 'unresolved',
    level: 'error',
    firstSeenAt: BASE - 2 * DAY,
    lastSeenAt: BASE - 3 * HOUR,
    eventCount: 15,
    userCount: 7,
  },
  {
    id: 'iss-address',
    projectId: 'demo-project',
    title: 'AddressError: Address validation service returned no candidates',
    status: 'resolved',
    level: 'warning',
    firstSeenAt: BASE - 21 * DAY,
    lastSeenAt: BASE - 5 * DAY,
    eventCount: 8,
    userCount: 5,
  },
  {
    id: 'iss-currency',
    projectId: 'demo-project',
    title: 'CurrencyError: Currency formatter received a non-numeric total',
    status: 'unresolved',
    level: 'warning',
    firstSeenAt: BASE - 2 * DAY,
    lastSeenAt: BASE - 6 * HOUR,
    eventCount: 6,
    userCount: 4,
  },
  {
    id: 'iss-payment',
    projectId: 'demo-project',
    title: 'PaymentMountError: Payment method component failed to mount',
    status: 'ignored',
    level: 'error',
    firstSeenAt: BASE - 21 * DAY,
    lastSeenAt: BASE - 18 * DAY,
    eventCount: 3,
    userCount: 2,
  },
  {
    id: 'iss-offline',
    projectId: 'mobile-web',
    title: 'NetworkError: Offline queue failed to flush',
    status: 'unresolved',
    level: 'error',
    firstSeenAt: BASE - 14 * DAY,
    lastSeenAt: BASE - 2 * HOUR,
    eventCount: 11,
    userCount: 6,
  },
  {
    id: 'iss-viewport',
    projectId: 'mobile-web',
    title: 'LayoutWarning: Viewport height changed during checkout',
    status: 'resolved',
    level: 'info',
    firstSeenAt: BASE - 10 * DAY,
    lastSeenAt: BASE - 9 * DAY,
    eventCount: 4,
    userCount: 3,
  },
  // 和 SQL 教程一样，留一个一条事件都没有的 Issue。
  {
    id: 'iss-tax',
    projectId: 'demo-project',
    title: 'TaxError: Tax rate lookup timed out',
    status: 'unresolved',
    level: 'warning',
    firstSeenAt: BASE - 30 * DAY,
    lastSeenAt: BASE - 30 * DAY,
    eventCount: 0,
    userCount: 0,
  },
];

const EVENTS = [
  {
    id: 'evt-0001',
    issueId: 'iss-hydrate',
    type: 'error',
    message: 'CheckoutStateError: Checkout state failed to hydrate',
    pageUrl: 'https://shop.test/checkout',
    userId: 'user-1',
    createdAt: BASE - 1 * HOUR,
  },
  {
    id: 'evt-0002',
    issueId: 'iss-hydrate',
    type: 'error',
    message: 'CheckoutStateError: Checkout state failed to hydrate',
    pageUrl: 'https://shop.test/checkout',
    userId: 'user-2',
    createdAt: BASE - 2 * HOUR,
  },
  {
    id: 'evt-0003',
    issueId: 'iss-promotion',
    type: 'error',
    message: 'PromotionError: Promotion response contained an invalid discount',
    pageUrl: 'https://shop.test/cart',
    userId: 'user-3',
    createdAt: BASE - 3 * HOUR,
  },
  {
    id: 'evt-0004',
    issueId: 'iss-currency',
    type: 'network',
    message: 'GET https://api.shop.test/rates → 503',
    pageUrl: 'https://shop.test/checkout',
    userId: 'user-1',
    createdAt: BASE - 6 * HOUR,
  },
  {
    id: 'evt-0005',
    issueId: 'iss-offline',
    type: 'error',
    message: 'NetworkError: Offline queue failed to flush',
    pageUrl: 'https://m.shop.test/checkout',
    userId: 'user-7',
    createdAt: BASE - 2 * HOUR,
  },
  // 和 SQL 教程一样，留两条 issue_id / user_id 为 null 的孤儿事件。
  {
    id: 'evt-0006',
    issueId: null,
    type: 'performance',
    message: 'LCP sample',
    pageUrl: 'https://shop.test/',
    userId: null,
    createdAt: BASE - 4 * HOUR,
  },
  {
    id: 'evt-0007',
    issueId: null,
    type: 'performance',
    message: 'CLS sample',
    pageUrl: 'https://shop.test/',
    userId: null,
    createdAt: BASE - 5 * HOUR,
  },
];

/** 深拷贝，保证每道练习拿到的都是干净数据，互不污染。 */
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * 创建一个全新的数据仓库。
 *
 * 注意每个方法上标注的「对应真实 SQL」——这一层在 TracePilot 里不是内存数组，
 * 而是 apps/server/src/services/queries.ts 里的 prepared statement。
 * 换成数据库之后，HTTP 这一层的代码一行都不用改，这正是分层的意义。
 */
export function createStore() {
  const projects = clone(PROJECTS);
  const issues = clone(ISSUES);
  const events = clone(EVENTS);

  return {
    /** SELECT * FROM projects ORDER BY created_at DESC */
    listProjects() {
      return clone(projects);
    },

    /** SELECT id FROM projects WHERE dsn_key = ? */
    findProjectByDsn(dsnKey) {
      return clone(projects.find((item) => item.dsnKey === dsnKey) ?? null);
    },

    /** SELECT 1 FROM projects WHERE id = ? */
    hasProject(projectId) {
      return projects.some((item) => item.id === projectId);
    },

    /**
     * SELECT * FROM issues WHERE project_id = ? [AND status = ?] [AND level = ?]
     * ORDER BY last_seen_at DESC LIMIT ? OFFSET ?
     *
     * 返回未分页的全量结果，分页交给练习自己实现——那正是要练的东西。
     */
    listIssues(projectId, filters = {}) {
      let rows = issues.filter((item) => item.projectId === projectId);
      if (filters.status && filters.status !== 'all') {
        rows = rows.filter((item) => item.status === filters.status);
      }
      if (filters.level && filters.level !== 'all') {
        rows = rows.filter((item) => item.level === filters.level);
      }
      // 与真实 SQL 的 ORDER BY last_seen_at DESC 一致；并列时用 id 兜底，保证结果确定。
      rows.sort((a, b) => b.lastSeenAt - a.lastSeenAt || a.id.localeCompare(b.id));
      return clone(rows);
    },

    /** SELECT * FROM issues WHERE id = ? */
    findIssue(issueId) {
      return clone(issues.find((item) => item.id === issueId) ?? null);
    },

    /** UPDATE issues SET status = ? WHERE id = ? —— 返回受影响行数，和 better-sqlite3 的 info.changes 一样。 */
    updateIssueStatus(issueId, status) {
      const issue = issues.find((item) => item.id === issueId);
      if (!issue) return 0;
      issue.status = status;
      return 1;
    },

    /** SELECT * FROM events WHERE issue_id = ? ORDER BY created_at DESC LIMIT ? */
    listIssueEvents(issueId, limit = 50) {
      return clone(
        events
          .filter((item) => item.issueId === issueId)
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, limit),
      );
    },

    /** SELECT 1 FROM events WHERE id = ? —— 幂等判定用，对应 services/events.ts 的 eventId 去重。 */
    hasEvent(eventId) {
      return events.some((item) => item.id === eventId);
    },

    /** INSERT INTO events (...) VALUES (...) */
    insertEvent(event) {
      events.push(clone(event));
    },

    /**
     * UPDATE issues SET event_count = event_count + 1, user_count = user_count + ? WHERE id = ?
     *
     * 这就是 README「技术难点 2」里那个增量累加——不要改成重新 COUNT(*)，
     * 那会让单次写入退化成 O(Issue 内事件数)。
     */
    bumpIssueCounters(issueId, firstSeenForUser) {
      const issue = issues.find((item) => item.id === issueId);
      if (!issue) return;
      issue.eventCount += 1;
      issue.userCount += firstSeenForUser ? 1 : 0;
    },

    /**
     * SELECT 1 FROM events WHERE issue_id = ? AND user_id = ? LIMIT 1
     *
     * 必须在插入本条事件「之前」调用，否则会查到刚写进去的那一行，user_count 恒为 0。
     * TracePilot 第一版就写反了，现在有一条回归测试专门锁这个顺序。
     */
    isFirstEventForUser(issueId, userId) {
      if (userId === null || userId === undefined) return false;
      return !events.some((item) => item.issueId === issueId && item.userId === userId);
    },

    /** 仅供判分使用：导出当前全量状态。 */
    snapshot() {
      return { projects: clone(projects), issues: clone(issues), events: clone(events) };
    },
  };
}

export { BASE, DAY, HOUR };
