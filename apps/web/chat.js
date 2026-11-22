'use strict';

const element = id => document.getElementById(id);
const POLL_MS = 2_000;
const RETRY_WINDOW_MS = 23 * 60 * 60_000;
const TOKEN_KEY = 'rab_token';
const SUBMISSION_KEY = 'rab_unconfirmed_submission_v1';
const SESSION_KEY = 'rab_current_session';
const deviceLabels = { online: '电脑在线', offline: '电脑离线', unpaired: '未绑定电脑', paused: '执行队列已暂停' };
const taskLabels = {
  awaiting_confirmation: '等待你确认', dispatch_pending: '等待电脑接单', queued: '电脑已接单 · 排队中', running: '电脑正在执行',
  cancel_requested: '已请求取消 · 等待确认', cancelled: '已取消', succeeded: '已完成', failed: '未成功', outcome_unknown: '结果未知',
};
const errorLabels = {
  agent_offline: '电脑暂未上线或正在重新认证，请稍后再试。',
  agent_disconnected: '与电脑的连接已断开，请先等待重新上线。',
  agent_queue_paused: '电脑未能确认上一个任务已停止。请先在电脑上检查并恢复队列。',
  device_not_authorized: '此账号没有这台电脑的操作权限。',
  device_not_found: '这台电脑已不再绑定，正在刷新状态。',
  invalid_pairing: '配对码不正确或已过期，请在电脑上重新生成。',
  pairing_rate_limited: '配对尝试过多，请稍后再试。',
  user_exists: '该邮箱已有账号，请登录。',
  invalid_credentials: '邮箱或密码不正确。',
  login_rate_limited: '尝试次数过多，请稍后再登录。',
  unauthorized: '登录已失效，请重新登录。',
  confirmation_expired: '确认已过期，任务未执行。',
  task_not_awaiting_confirmation: '此任务已不再等待确认，正在刷新状态。',
  task_device_binding_changed: '设备授权已改变，不能批准这次请求。',
  provider_not_found: '执行器当前不可用，请选择已上线的执行器。',
  session_operation_timeout: '新会话未能及时确认，请先查看会话列表。',
  session_has_active_tasks: '此会话还有任务，请先处理或等待结束。',
  session_not_found: '会话已不存在，正在刷新列表。',
  task_queue_full: '任务队列已满，请等现有任务结束后再试。',
  task_history_full: '近期记录已达到上限，暂不能添加新任务。',
  task_id_conflict: '此任务编号与当前内容不匹配，未重新发送。',
  task_cancellation_unsupported: '旧版 Agent 不支持从页面取消此任务。',
  state_write_failed: '电脑未能保存记录。请检查数据目录和可用磁盘空间。',
};

function stored(key) {
  try { return sessionStorage.getItem(key) ?? ''; }
  catch { return ''; }
}

function store(key, value) {
  try {
    if (value) sessionStorage.setItem(key, value);
    else sessionStorage.removeItem(key);
  } catch {}
}

function restoredSubmission() {
  try {
    const item = JSON.parse(stored(SUBMISSION_KEY));
    const body = item?.body;
    if (Number.isFinite(item?.createdAt) && typeof body?.task_id === 'string' && /^task-[0-9a-f]{32}$/.test(body.task_id) &&
        typeof body.session_id === 'string' && typeof body.provider_id === 'string' && typeof body.input === 'string' &&
        body.input.length <= 32_768 && body.mode === 'isolated') return item;
  } catch {}
  return null;
}

let token = stored(TOKEN_KEY);
let authGeneration = 0;
let authMode = 'login';
let authBusy = false;
let device = { status: 'loading' };
let providers = [];
let sessions = [];
let selectedId = token ? stored(SESSION_KEY) : '';
let selectionVersion = 0;
let pending = token ? restoredSubmission() : null;
let submissionBusy = false;
let creating = false;
let pairing = false;
let revoking = false;
let connectionError = false;
let sessionLoading = true;
let poll;
let pollTimer;
let lastTag = '';
let listSignature = '';
let providerSignature = '';
let chatSignature = '';
let chatSession = '';
let chatNodes = new Map();
const drafts = new Map();
const activeActions = new Set();
const compact = matchMedia('(max-width: 760px)');

class ApiError extends Error {
  constructor(status, code) { super(errorLabels[code] ?? (status >= 500 ? '服务暂时不可用，请稍后查看。' : '请求未完成，请检查当前状态。')); this.status = status; this.code = code; }
}

async function api(path, { method = 'GET', body, signal, tag, anonymous = false } = {}) {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), 8_000);
  const abortRequest = () => deadline.abort();
  if (signal?.aborted) abortRequest();
  else signal?.addEventListener('abort', abortRequest, { once: true });
  const generation = authGeneration;
  try {
    const response = await fetch(path, {
      method, signal: deadline.signal, cache: 'no-store',
      headers: {
        ...(token && !anonymous ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(tag ? { 'if-none-match': tag } : {}),
      },
      body: body && JSON.stringify(body),
    });
    if (response.status === 304) return { unchanged: true };
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 401 && data?.error === 'unauthorized' && !anonymous && generation === authGeneration) {
        logout(errorLabels.unauthorized);
      }
      throw new ApiError(response.status, data?.error);
    }
    return { data, tag: response.headers.get('etag') ?? '' };
  } finally {
    signal?.removeEventListener('abort', abortRequest);
    clearTimeout(timer);
  }
}

function textNotice(id, text) {
  const node = element(id);
  if (node.textContent !== text) node.textContent = text;
  node.hidden = !text;
}

function notice(text) { textNotice('appNotice', text); }
const errorText = error => error instanceof ApiError ? error.message : '连接中断或返回异常，请检查网络后再试。';

function node(tag, className, text) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}

function button(text, className, action) {
  const result = node('button', className, text);
  result.type = 'button';
  result.addEventListener('click', action);
  return result;
}

function setAuthMode(mode) {
  authMode = mode;
  const login = mode === 'login';
  element('authTitle').textContent = login ? '登录你的工作台' : '创建工作台账号';
  element('authButton').textContent = login ? '登录' : '创建账号';
  element('authSwitch').textContent = login ? '没有账号？创建账号' : '已有账号？返回登录';
  element('password').autocomplete = login ? 'current-password' : 'new-password';
  textNotice('authError', '');
}

async function submitAuth(event) {
  event.preventDefault();
  if (authBusy) return;
  authBusy = true;
  element('authButton').disabled = true;
  element('authSwitch').disabled = true;
  textNotice('authError', '');
  try {
    const { data } = await api(`/api/auth/${authMode}`, { method: 'POST', anonymous: true, body: { email: element('email').value.trim(), password: element('password').value } });
    if (typeof data?.token !== 'string' || !data.token) throw new Error('invalid_login_response');
    store(SUBMISSION_KEY, '');
    store(SESSION_KEY, '');
    token = data.token;
    authGeneration += 1;
    store(TOKEN_KEY, token);
    element('password').value = '';
    showApp();
  } catch (error) { textNotice('authError', errorText(error)); }
  finally {
    authBusy = false;
    element('authButton').disabled = false;
    element('authSwitch').disabled = false;
  }
}

function showApp() {
  element('authView').hidden = true;
  element('appView').hidden = false;
  element('setupLink').hidden = !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  renderControls();
  renderChat(null);
  refreshNow();
}

function logout(reason = '') {
  authGeneration += 1;
  stopPoll();
  token = '';
  for (const key of [TOKEN_KEY, SUBMISSION_KEY, SESSION_KEY]) store(key, '');
  pending = null;
  submissionBusy = creating = pairing = revoking = connectionError = false;
  sessionLoading = true;
  device = { status: 'loading' };
  providers = [];
  sessions = [];
  selectedId = '';
  listSignature = providerSignature = chatSignature = chatSession = '';
  lastTag = '';
  activeActions.clear();
  drafts.clear();
  chatNodes.clear();
  element('input').value = '';
  for (const id of ['sessionList', 'providerSelect', 'chat']) element(id).replaceChildren();
  if (element('pairDialog').open) element('pairDialog').close();
  element('pairSubmit').disabled = false;
  element('pairCode').value = '';
  setSidebar(false, false);
  notice('');
  textNotice('pairError', '');
  textNotice('connectionNotice', '');
  element('appView').hidden = true;
  element('authView').hidden = false;
  setAuthMode('login');
  textNotice('authError', reason);
  element('email').focus();
}

function stopPoll() {
  clearTimeout(pollTimer);
  poll?.abort();
  poll = undefined;
}

function refreshNow() {
  stopPoll();
  lastTag = '';
  void refresh();
}

async function refresh() {
  if (!token || document.hidden || poll) return;
  const generation = authGeneration;
  const controller = new AbortController();
  const requestedId = selectedId;
  const path = requestedId ? `/api/dashboard?session_id=${encodeURIComponent(requestedId)}` : '/api/dashboard';
  poll = controller;
  try {
    const { data, unchanged, tag } = await api(path, { signal: controller.signal, tag: lastTag });
    if (poll !== controller || generation !== authGeneration) return;
    if (!unchanged && (!data?.device || !Array.isArray(data.providers) || !Array.isArray(data.sessions))) throw new Error('invalid_dashboard');
    connectionError = false;
    textNotice('connectionNotice', '');
    if (!unchanged) {
      lastTag = tag;
      device = data.device;
      providers = data.providers;
      sessions = data.sessions;
      setSelection(data.selected?.session_id ?? '');
      sessionLoading = false;
      if (pending && !submissionBusy && data.selected?.session_id === pending.body.session_id &&
          data.selected.tasks.some(task => task.task_id === pending.body.task_id)) completeSubmission(pending);
      renderProviders();
      renderSessions();
      renderChat(data.selected);
    }
    renderControls();
  } catch {
    if (poll !== controller || generation !== authGeneration) return;
    connectionError = true;
    textNotice('connectionNotice', '暂时无法连接 Gateway，保留上次看到的内容。网络恢复后会自动更新。');
    renderControls();
  } finally {
    if (poll === controller) {
      poll = undefined;
      if (token && !document.hidden) pollTimer = setTimeout(refresh, connectionError ? 4_000 : POLL_MS);
    }
  }
}

function currentSession() { return sessions.find(session => session.id === selectedId); }

function setSelection(id) {
  if (id === selectedId) return;
  if (selectedId) drafts.set(selectedId, element('input').value);
  selectedId = id;
  selectionVersion += 1;
  store(SESSION_KEY, id);
  element('input').value = drafts.get(id) ?? '';
}

function openSession(id) {
  setSidebar(false);
  if (id === selectedId && !sessionLoading) return;
  setSelection(id);
  sessionLoading = true;
  notice('');
  renderSessions();
  renderChat(null);
  renderControls();
  refreshNow();
}

function setSidebar(open, restoreFocus = true) {
  const expanded = open && compact.matches;
  const sidebar = element('sidebar');
  const wasOpen = sidebar.classList.contains('open');
  sidebar.classList.toggle('open', expanded);
  element('main').inert = expanded;
  element('sidebarOverlay').hidden = !expanded;
  element('openSidebar').setAttribute('aria-expanded', String(expanded));
  if (expanded && !wasOpen) element('closeSidebar').focus();
  if (!expanded && wasOpen && restoreFocus && compact.matches) element('openSidebar').focus();
}

function renderProviders() {
  const signature = JSON.stringify(providers.map(provider => [provider.id, provider.name]));
  if (providerSignature === signature) return;
  providerSignature = signature;
  const select = element('providerSelect');
  const previous = select.value;
  select.replaceChildren(...providers.map(provider => {
    const option = node('option', '', provider.id === 'local' ? '本机只读（Local）' : provider.name);
    option.value = provider.id;
    return option;
  }));
  if (!providers.length) select.append(node('option', '', '暂无在线执行器'));
  if (providers.some(provider => provider.id === previous)) select.value = previous;
  else if (providers.some(provider => provider.id === 'local')) select.value = 'local';
}

function renderSessions() {
  const signature = JSON.stringify([selectedId, sessions]);
  if (listSignature === signature) return;
  listSignature = signature;
  const list = element('sessionList');
  const focused = document.activeElement?.dataset.session;
  const controls = sessions.map(session => {
    const current = selectedId === session.id;
    const row = node('div', `session-row${current ? ' active' : ''}`);
    const open = button('', 'session-open', () => openSession(session.id));
    open.dataset.session = session.id;
    if (current) open.setAttribute('aria-current', 'true');
    const activity = session.awaiting ? ` · ${session.awaiting} 待确认` : session.active ? ` · ${session.active} 进行中` : '';
    open.append(node('span', 'session-name', session.title), node('small', 'session-meta', `${session.provider_id}${activity}`));
    const remove = button('×', 'session-remove', () => void deleteSession(session));
    remove.setAttribute('aria-label', `删除会话 ${session.title}`);
    remove.disabled = Boolean(session.active);
    row.append(open, remove);
    return row;
  });
  list.replaceChildren(...(controls.length ? controls : [node('p', 'session-meta', '还没有会话')]));
  if (focused) [...list.querySelectorAll('[data-session]')].find(control => control.dataset.session === focused)?.focus();
}

function renderControls() {
  const status = element('deviceStatus');
  status.dataset.state = device.status;
  const label = deviceLabels[device.status] ?? '检查电脑状态';
  if (element('deviceText').textContent !== label) element('deviceText').textContent = label;
  status.title = device.name ?? '';
  element('pairOpen').hidden = device.status !== 'unpaired';
  element('revokeDevice').hidden = !device.id;
  element('revokeDevice').disabled = revoking || connectionError;
  element('newSession').disabled = !canCreate() || creating;
  element('providerSelect').disabled = !providers.length || connectionError;
  const session = currentSession();
  element('currentTitle').textContent = session?.title ?? (sessionLoading ? '正在读取会话…' : '没有打开的会话');
  element('currentSub').hidden = !session;
  element('currentSub').textContent = session ? `${session.provider_id} · 后台执行` : '';
  const usable = Boolean(session && providers.some(provider => provider.id === session.provider_id));
  element('input').disabled = !session || sessionLoading;
  element('sendTask').disabled = !usable || device.status !== 'online' || revoking || sessionLoading || connectionError || Boolean(pending) || !element('input').value.trim();
  element('composerHint').textContent = device.status === 'paused' ? '请先在电脑上核对旧任务是否停止，再恢复队列。' : session && device.status === 'online' && !usable ? '此会话的执行器未上线；可以查看记录或新建会话。' : '后台执行 · 状态以 Gateway 记录为准';
  renderPending();
}

function canCreate() { return !connectionError && !revoking && ['online', 'paused'].includes(device.status) && providers.length > 0; }

async function createSession() {
  if (!canCreate() || creating) return;
  const generation = authGeneration;
  const selection = selectionVersion;
  const providerId = element('providerSelect').value;
  const name = providers.find(provider => provider.id === providerId)?.name ?? providerId;
  creating = true;
  renderControls();
  notice('正在创建会话…');
  try {
    const { data } = await api('/api/sessions', { method: 'POST', body: { provider_id: providerId, title: `${name.slice(0, 100)} · ${new Date().toLocaleTimeString()}` } });
    if (generation !== authGeneration) return;
    if (!data?.session?.id) throw new Error('invalid_session_response');
    if (selection === selectionVersion) {
      setSidebar(false);
      setSelection(data.session.id);
      sessionLoading = true;
      renderChat(null);
    }
    notice('会话已创建。');
  } catch (error) { if (generation === authGeneration) notice(errorText(error)); }
  finally {
    if (generation === authGeneration) { creating = false; renderControls(); refreshNow(); }
  }
}

async function deleteSession(session) {
  if (!confirm(`删除「${session.title}」及其会话消息？近期任务记录仍按保留期清理。`)) return;
  const generation = authGeneration;
  const key = `session:${session.id}`;
  if (activeActions.has(key)) return;
  activeActions.add(key);
  try {
    await api(`/api/sessions/${encodeURIComponent(session.id)}`, { method: 'DELETE' });
    if (generation === authGeneration) notice('会话已删除。');
  } catch (error) { if (generation === authGeneration) notice(errorText(error)); }
  finally {
    if (generation === authGeneration) { activeActions.delete(key); refreshNow(); }
  }
}

function emptyView() {
  const view = node('div', 'empty');
  const label = sessionLoading ? '同步中' : deviceLabels[device.status] ?? '工作台';
  const session = currentSession();
  view.append(node('div', 'eyebrow', label));
  if (sessionLoading) {
    view.append(node('h2', '', '正在读取会话'), node('p', '', '连接 Gateway 后会显示消息和任务记录。'));
  } else if (session) {
    view.append(node('h2', '', '开始这次会话'), node('p', '', session.provider_id === 'local' ? '本机只读执行器可以查询时间、系统、进程，或读取允许范围内的工作区文件。' : '任务会交给此会话的执行器。请在电脑上检查它的实际权限。'));
  } else if (device.status === 'unpaired') {
    view.append(node('h2', '', '先绑定你的电脑'), node('p', '', '在电脑配置页生成配对码。Agent 完成认证后，就可以新建会话。'), button('输入配对码', 'primary', openPairForm));
  } else if (canCreate()) {
    view.append(node('h2', '', '新建一个会话'), node('p', '', '默认选择本机只读执行器。也可以在会话菜单切换新会话的执行器。'), button('新建会话', 'primary', () => void createSession()));
  } else {
    view.append(node('h2', '', '等待电脑上线'), node('p', '', '请确认电脑上的 Gateway 和 Agent 都已启动。上线后页面会自动更新。'));
  }
  return view;
}

function messageView(message) {
  const role = message.role === 'user' ? 'user' : 'assistant';
  const row = node('div', `message ${role}`);
  const avatar = node('span', 'avatar', role === 'user' ? '你' : '电脑');
  avatar.setAttribute('aria-hidden', 'true');
  const bubble = node('div', 'bubble');
  bubble.append(node('span', 'sr-only', role === 'user' ? '你：' : '电脑：'), document.createTextNode(message.content));
  row.append(avatar, bubble);
  return row;
}

function taskView(task) {
  const card = node('article', 'task-card');
  card.dataset.state = task.state;
  card.dataset.task = task.task_id;
  const heading = node('div', 'task-head');
  heading.append(node('h2', '', taskLabels[task.state] ?? '任务状态未知'));
  const date = new Date(task.updated_at);
  const meta = node('span', 'task-time', `${task.provider_id ?? '电脑'} · ${date.toLocaleTimeString()}`);
  meta.title = task.task_id;
  heading.append(meta);
  card.append(heading);
  if (task.message) card.append(node('p', '', task.message));
  const controls = node('div', 'button-row');
  const makeControl = (text, className, action) => {
    const control = button(text, className, () => void taskAction(task, action));
    control.dataset.action = action;
    control.disabled = activeActions.has(task.task_id);
    return control;
  };
  if (task.state === 'awaiting_confirmation') {
    if (task.confirmation_input) card.append(node('p', 'confirmation-input', task.confirmation_input));
    if (task.confirmation_expires_at) card.append(node('p', '', `请在 ${new Date(task.confirmation_expires_at).toLocaleTimeString()} 前处理。确认只批准本任务，不改变执行器权限。`));
    const approve = makeControl('确认执行', 'primary', 'confirm');
    approve.disabled ||= device.status !== 'online';
    controls.append(approve, makeControl('拒绝', 'secondary', 'deny'));
  } else if (task.can_cancel) controls.append(makeControl('请求取消', 'secondary', 'cancel'));
  if (controls.childElementCount) card.append(controls);
  if (Array.isArray(task.actions) && task.actions.length) {
    const details = node('details', 'actions');
    details.append(node('summary', '', `执行记录（${task.actions.length} 项）`));
    for (const action of task.actions) {
      const label = action.exit_code == null ? '' : ` · 退出码 ${action.exit_code}`;
      const line = node('div', 'action-line');
      line.append(node('code', '', action.detail), document.createTextNode(label));
      details.append(line);
    }
    card.append(details);
  }
  return card;
}

function renderChat(snapshot) {
  const chat = element('chat');
  const msgs = snapshot?.messages ?? [];
  const tasks = snapshot?.tasks ?? [];
  const signature = JSON.stringify([selectedId, sessionLoading, device.status, Boolean(providers.length), msgs, tasks]);
  if (signature === chatSignature) return;
  chatSignature = signature;
  const changeSession = chatSession !== selectedId;
  const follow = changeSession || chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80;
  const entries = [
    ...msgs.map(message => ({ key: `message:${message.id}`, time: Date.parse(message.created_at), data: message, render: messageView })),
    ...tasks.map(task => ({ key: `task:${task.task_id}`, time: task.updated_at, data: task, render: taskView })),
  ].sort((left, right) => left.time - right.time);
  if (!entries.length) {
    chat.replaceChildren(emptyView());
    chatNodes.clear();
  } else {
    const previousNodes = changeSession ? new Map() : chatNodes;
    const newNodes = new Map();
    let position = chat.firstChild;
    for (const entry of entries) {
      const stamp = JSON.stringify(entry.data);
      const previous = previousNodes.get(entry.key);
      const current = stamp === previous?.stamp ? previous.node : entry.render(entry.data);
      if (current === position) position = position.nextSibling;
      else chat.insertBefore(current, position);
      newNodes.set(entry.key, { stamp, node: current });
      if (entry.render === taskView) {
        const disabled = activeActions.has(entry.data.task_id);
        for (const control of current.querySelectorAll('[data-action]')) {
          control.disabled = disabled || (control.dataset.action === 'confirm' && device.status !== 'online');
        }
      }
    }
    while (position) {
      const old = position;
      position = position.nextSibling;
      old.remove();
    }
    chatNodes = newNodes;
  }
  chatSession = selectedId;
  if (follow) chat.scrollTop = chat.scrollHeight;
}

function setPending(item) {
  pending = item;
  store(SUBMISSION_KEY, item ? JSON.stringify(item) : '');
}

function renderPending() {
  const panel = element('pendingSubmission');
  panel.hidden = !pending;
  if (!pending) return;
  const expired = Date.now() - pending.createdAt >= RETRY_WINDOW_MS;
  const session = sessions.find(record => record.id === pending.body.session_id);
  element('pendingTitle').textContent = submissionBusy ? '正在核对提交…' : '有一条提交尚未收到回执';
  const where = session?.title ? `「${session.title}」中的任务` : '这个任务';
  element('pendingHint').textContent = expired ? '这次提交已超过安全重试窗口。请在电脑上核对，不要当作未执行。' : `${where}可能已经提交。可先查询，或明确用原编号重试；系统不会自动重发。`;
  element('retryTask').disabled = expired || submissionBusy;
  element('checkTask').disabled = submissionBusy;
  element('discardTask').disabled = submissionBusy;
}

function completeSubmission(item) {
  if (pending !== item) return;
  if (drafts.get(item.body.session_id)?.trim() === item.body.input) drafts.delete(item.body.session_id);
  if (selectedId === item.body.session_id && element('input').value.trim() === item.body.input) element('input').value = '';
  setPending(null);
  notice('已找到这条任务，执行情况以会话中的状态为准。');
}

async function transmit(item, { first = false, check = false } = {}) {
  if (submissionBusy || pending !== item) return;
  if (!check && Date.now() - item.createdAt >= RETRY_WINDOW_MS) { renderPending(); return; }
  const generation = authGeneration;
  submissionBusy = true;
  notice('');
  renderControls();
  try {
    const result = check
      ? await api(`/api/tasks/${encodeURIComponent(item.body.task_id)}`)
      : await api('/api/tasks', { method: 'POST', body: item.body });
    if (generation !== authGeneration) return;
    if (result.data?.task_id !== item.body.task_id || (!check && !result.data.accepted)) throw new Error('invalid_task_response');
    completeSubmission(item);
  } catch (error) {
    if (generation !== authGeneration) return;
    const definitelyRejected = ['agent_offline', 'device_not_authorized', 'agent_queue_paused', 'provider_not_found', 'session_not_found', 'task_queue_full', 'task_history_full', 'state_write_failed', 'task_requires_task_id_and_input'];
    if (first && error instanceof ApiError && definitelyRejected.includes(error.code)) setPending(null);
    notice(check && error instanceof ApiError && error.status === 404 ? '暂未查到这条任务。不代表电脑没有执行；请用原编号核对或在电脑上检查。' : errorText(error));
  } finally {
    if (generation === authGeneration) { submissionBusy = false; renderControls(); refreshNow(); }
  }
}

function sendTask(event) {
  event?.preventDefault();
  if (element('sendTask').disabled || pending) return;
  const session = currentSession();
  if (!session) return;
  const random = crypto.getRandomValues(new Uint8Array(16));
  const taskId = 'task-' + Array.from(random, byte => byte.toString(16).padStart(2, '0')).join('');
  const item = { createdAt: Date.now(), body: {
    task_id: taskId, input: element('input').value.trim(), session_id: session.id, provider_id: session.provider_id, mode: 'isolated',
  } };
  setPending(item);
  void transmit(item, { first: true });
}

async function taskAction(task, action) {
  if (activeActions.has(task.task_id)) return;
  const generation = authGeneration;
  activeActions.add(task.task_id);
  const view = chatNodes.get(`task:${task.task_id}`)?.node;
  for (const control of view?.querySelectorAll('button') ?? []) control.disabled = true;
  try {
    await api(`/api/tasks/${encodeURIComponent(task.task_id)}/${action}`, { method: 'POST' });
    if (generation === authGeneration) notice('操作已提交，任务卡将显示电脑确认的状态。');
  } catch (error) { if (generation === authGeneration) notice(errorText(error)); }
  finally {
    if (generation === authGeneration) {
      activeActions.delete(task.task_id);
      const current = chatNodes.get(`task:${task.task_id}`)?.node;
      for (const control of current?.querySelectorAll('button') ?? []) control.disabled = control.dataset.action === 'confirm' && device.status !== 'online';
      refreshNow();
    }
  }
}

function openPairForm() {
  if (!token || pairing || element('pairDialog').open) return;
  element('pairCode').value = '';
  textNotice('pairError', '');
  element('pairDialog').showModal();
  element('pairCode').focus();
}

async function pairDevice(event) {
  event.preventDefault();
  if (pairing) return;
  const generation = authGeneration;
  pairing = true;
  element('pairSubmit').disabled = true;
  textNotice('pairError', '');
  try {
    const { data } = await api('/api/pairings/authorize', { method: 'POST', body: { code: element('pairCode').value.trim() } });
    if (generation !== authGeneration) return;
    if (data?.authorized !== true) throw new Error('invalid_pairing_response');
    element('pairDialog').close();
    element('pairCode').value = '';
    notice('配对成功。电脑重新认证后，可从会话菜单新建会话。');
  } catch (error) { if (generation === authGeneration) textNotice('pairError', errorText(error)); }
  finally {
    if (generation === authGeneration) { pairing = false; element('pairSubmit').disabled = false; refreshNow(); }
  }
}

async function revokeDevice() {
  if (!device.id || revoking) return;
  if (!confirm(`解除「${device.name || '这台电脑'}」的绑定？重新使用需要配对。已派发的任务仍需在电脑上核对；会话历史不会清除。`)) return;
  const id = device.id;
  const generation = authGeneration;
  revoking = true;
  renderControls();
  try {
    const { data } = await api(`/api/devices/${encodeURIComponent(id)}/revoke`, { method: 'POST' });
    if (generation !== authGeneration) return;
    if (data?.revoked !== true) throw new Error('invalid_revocation_response');
    if (device.id === id) {
      stopPoll();
      device = { status: 'unpaired' };
      providers = [];
      renderProviders();
    }
    setSidebar(false);
    notice('已解除绑定。会话历史仍可查看。');
  } catch (error) {
    if (generation === authGeneration) notice(errorText(error));
  } finally {
    if (generation === authGeneration) { revoking = false; renderControls(); refreshNow(); }
  }
}

element('authForm').addEventListener('submit', submitAuth);
element('authSwitch').addEventListener('click', () => setAuthMode(authMode === 'login' ? 'register' : 'login'));
element('logout').addEventListener('click', () => logout());
element('revokeDevice').addEventListener('click', () => void revokeDevice());
element('openSidebar').addEventListener('click', () => setSidebar(true));
element('closeSidebar').addEventListener('click', () => setSidebar(false));
element('sidebarOverlay').addEventListener('click', () => setSidebar(false));
compact.addEventListener('change', () => setSidebar(false, false));
element('newSession').addEventListener('click', () => void createSession());
element('pairOpen').addEventListener('click', openPairForm);
element('pairForm').addEventListener('submit', pairDevice);
element('pairClose').addEventListener('click', () => element('pairDialog').close());
element('composer').addEventListener('submit', sendTask);
element('input').addEventListener('input', renderControls);
element('input').addEventListener('keydown', event => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing && event.keyCode !== 229) sendTask(event);
});
element('retryTask').addEventListener('click', () => { if (pending) void transmit(pending); });
element('checkTask').addEventListener('click', () => { if (pending) void transmit(pending, { check: true }); });
element('discardTask').addEventListener('click', () => {
  if (pending && confirm('仅放弃这次重试，不会取消电脑上的任务。仍要放弃吗？')) {
    setPending(null);
    notice('已停止重试；这不表示任务没有执行。');
    renderControls();
  }
});
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !element('pairDialog').open) setSidebar(false); });
document.addEventListener('visibilitychange', () => { if (document.hidden) stopPoll(); else refreshNow(); });
window.addEventListener('online', refreshNow);

if (token) showApp();
