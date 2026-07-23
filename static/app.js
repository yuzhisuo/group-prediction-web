'use strict';

const state = {
  topics: [],
  search: '',
  socket: null,
  reconnectTimer: null,
  heartbeatTimer: null,
  reconnectDelay: 1000,
  currentDetailId: null,
};

const elements = {
  topicForm: document.querySelector('#topicForm'),
  predictionForm: document.querySelector('#predictionForm'),
  topicIdInput: document.querySelector('#topicIdInput'),
  participantInput: document.querySelector('#participantInput'),
  topicsContainer: document.querySelector('#topicsContainer'),
  loadingState: document.querySelector('#loadingState'),
  connectionStatus: document.querySelector('#connectionStatus'),
  refreshButton: document.querySelector('#refreshButton'),
  searchInput: document.querySelector('#searchInput'),
  shareButton: document.querySelector('#shareButton'),
  toast: document.querySelector('#toast'),
  detailModal: document.querySelector('#detailModal'),
  detailContent: document.querySelector('#detailContent'),
  detailTitle: document.querySelector('#detailTitle'),
  detailTopicId: document.querySelector('#detailTopicId'),
  closeDetailButton: document.querySelector('#closeDetailButton'),
};

let toastTimer = null;

function showToast(message, isError = false) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle('error', isError);
  elements.toast.classList.add('show');
  toastTimer = setTimeout(() => elements.toast.classList.remove('show'), 3000);
}

function setConnection(status, label) {
  elements.connectionStatus.className = `connection ${status}`;
  elements.connectionStatus.textContent = label;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const detail = payload?.detail;
    const message = Array.isArray(detail)
      ? detail.map((item) => item.msg).join('；')
      : detail || `请求失败（${response.status}）`;
    throw new Error(message);
  }
  return payload;
}

function adminToken() {
  const input = elements.detailContent.querySelector('#adminTokenInput');
  const value = input?.value.trim() || sessionStorage.getItem('prediction_admin_token') || '';
  if (value) sessionStorage.setItem('prediction_admin_token', value);
  return value;
}

async function adminRequest(url, options = {}) {
  const token = adminToken();
  if (!token) throw new Error('请先填写管理员口令');
  return requestJson(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      'X-Admin-Token': token,
    },
  });
}

function formatTime(value) {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value));
  } catch {
    return '';
  }
}

function coefficient(value) {
  return value > 0 ? value.toFixed(2) : '—';
}

function signedPoints(value) {
  if (value > 0) return `+${value}`;
  return String(value);
}

function createElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function metric(className, value, label) {
  const box = createElement('div', `metric ${className}`.trim());
  box.append(createElement('strong', '', value));
  box.append(createElement('span', '', label));
  return box;
}

function statusClass(status) {
  if (status === 'open') return 'status-open';
  if (status === 'locked') return 'status-locked';
  return 'status-settled';
}

function selectTopic(topic, side) {
  if (topic.status !== 'open') {
    showToast('该题目已封盘或结算，无法继续提交', true);
    return;
  }
  elements.topicIdInput.value = topic.id;
  const radio = elements.predictionForm.querySelector(`input[name="side"][value="${side}"]`);
  radio.checked = true;
  elements.predictionForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
  if (!elements.participantInput.value) {
    elements.participantInput.focus({ preventScroll: true });
  }
  showToast(`已选择题目 #${topic.id} 的${side === 'red' ? '红方' : '蓝方'}`);
}

function topicCard(topic) {
  const card = createElement('article', 'topic-card');
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `查看题目 ${topic.id} 详情`);
  card.addEventListener('click', () => openDetails(topic.id));
  card.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openDetails(topic.id);
    }
  });

  const header = createElement('div', 'topic-card-header');
  const titleBlock = createElement('div');
  const idRow = createElement('div', 'topic-id-row');
  idRow.append(
    createElement('div', 'topic-id', `TOPIC #${topic.id}`),
    createElement('span', `status-badge ${statusClass(topic.status)}`, topic.status_label),
  );
  titleBlock.append(idRow, createElement('h3', 'topic-title', topic.title));
  if (topic.winning_label) {
    titleBlock.append(createElement('p', 'winning-note', `结算结果：${topic.winning_label} 获胜`));
  }
  const meta = createElement(
    'div',
    'topic-meta',
    `${topic.participant_count} 人参与 · ${formatTime(topic.created_at)}`,
  );
  header.append(titleBlock, meta);

  const scoreArea = createElement('div', 'score-area');
  const scoreRow = createElement('div', 'score-row');
  scoreRow.append(
    createElement('div', 'team-name red', topic.red_label),
    createElement('div', 'score-divider', `${topic.total_points} 总积分`),
    createElement('div', 'team-name blue', topic.blue_label),
  );
  const track = createElement('div', 'progress-track');
  const redBar = createElement('div', 'progress-red');
  const blueBar = createElement('div', 'progress-blue');
  redBar.style.width = `${topic.red_ratio}%`;
  blueBar.style.width = `${topic.blue_ratio}%`;
  redBar.title = `红方 ${topic.red_ratio}%`;
  blueBar.title = `蓝方 ${topic.blue_ratio}%`;
  track.append(redBar, blueBar);
  scoreArea.append(scoreRow, track);

  const metrics = createElement('div', 'metrics');
  metrics.append(
    metric('red', `${topic.red_points}`, '红方积分'),
    metric('blue', `${topic.blue_points}`, '蓝方积分'),
    metric('red', `${topic.red_ratio}% / ${coefficient(topic.red_coefficient)}`, '红方占比 / 系数'),
    metric('blue', `${topic.blue_ratio}% / ${coefficient(topic.blue_coefficient)}`, '蓝方占比 / 系数'),
  );

  const actions = createElement('div', `topic-actions ${topic.status !== 'open' ? 'closed-actions' : ''}`);
  if (topic.status === 'open') {
    const redButton = createElement('button', 'side-pick-button red', `选择 ${topic.red_label}`);
    redButton.type = 'button';
    redButton.addEventListener('click', (event) => {
      event.stopPropagation();
      selectTopic(topic, 'red');
    });
    const blueButton = createElement('button', 'side-pick-button blue', `选择 ${topic.blue_label}`);
    blueButton.type = 'button';
    blueButton.addEventListener('click', (event) => {
      event.stopPropagation();
      selectTopic(topic, 'blue');
    });
    actions.append(redButton, blueButton);
  } else {
    actions.append(createElement('div', 'closed-message', topic.status === 'locked'
      ? '已封盘，只能查看参与明细并等待结算'
      : `已结算：${topic.winning_label} 获胜，点击查看每个 ID 的积分结果`));
  }

  const hint = createElement('div', 'detail-hint', '点击卡片查看参与明细与管理操作');
  card.append(header, scoreArea, metrics, actions, hint);
  return card;
}

function renderTopics() {
  const keyword = state.search.trim().toLowerCase();
  const topics = state.topics.filter((topic) => {
    if (!keyword) return true;
    return String(topic.id).includes(keyword)
      || topic.title.toLowerCase().includes(keyword)
      || topic.red_label.toLowerCase().includes(keyword)
      || topic.blue_label.toLowerCase().includes(keyword)
      || topic.status_label.toLowerCase().includes(keyword);
  });

  elements.topicsContainer.replaceChildren();
  elements.loadingState.hidden = true;
  if (topics.length === 0) {
    elements.loadingState.hidden = false;
    elements.loadingState.textContent = state.topics.length
      ? '没有找到符合条件的题目。'
      : '目前还没有预测题，创建第一个题目吧。';
    return;
  }
  const fragment = document.createDocumentFragment();
  topics.forEach((topic) => fragment.append(topicCard(topic)));
  elements.topicsContainer.append(fragment);
}

async function loadTopics({ silent = false } = {}) {
  try {
    const topics = await requestJson('/api/topics');
    state.topics = topics;
    renderTopics();
    if (!silent) showToast('题目已刷新');
  } catch (error) {
    elements.loadingState.hidden = false;
    elements.loadingState.textContent = '读取失败，请稍后重试。';
    showToast(error.message, true);
  }
}

function formPayload(form) {
  return Object.fromEntries(new FormData(form).entries());
}

async function submitForm(form, url, transform, successMessage) {
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = '正在提交…';
  try {
    const payload = transform(formPayload(form));
    const result = await requestJson(url, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    successMessage(result);
    return result;
  } catch (error) {
    showToast(error.message, true);
    return null;
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

function tableCell(text, className = '') {
  return createElement('td', className, text);
}

function buildPredictionsTable(topic) {
  if (!topic.predictions.length) {
    return createElement('div', 'empty-inline', '当前没有参与记录。');
  }
  const wrapper = createElement('div', 'table-scroll');
  const table = createElement('table', 'detail-table');
  const head = createElement('thead');
  const headRow = createElement('tr');
  ['参与者 ID', '选择', '虚拟积分', '最后更新'].forEach((label) => {
    headRow.append(createElement('th', '', label));
  });
  head.append(headRow);
  const body = createElement('tbody');
  topic.predictions.forEach((item) => {
    const row = createElement('tr');
    row.append(
      tableCell(item.participant_id),
      tableCell(item.side_label, item.side === 'red' ? 'text-red' : 'text-blue'),
      tableCell(String(item.points)),
      tableCell(formatTime(item.updated_at)),
    );
    body.append(row);
  });
  table.append(head, body);
  wrapper.append(table);
  return wrapper;
}

function buildSettlementTable(settlement) {
  if (!settlement || !settlement.rows.length) return null;
  const section = createElement('section', 'detail-section settlement-section');
  section.append(
    createElement('h3', '', '结算结果'),
    createElement(
      'p',
      'detail-note',
      `${settlement.winning_label} 获胜。总积分池 ${settlement.total_pool}，按胜方各 ID 的投入比例分配。`,
    ),
  );
  const wrapper = createElement('div', 'table-scroll');
  const table = createElement('table', 'detail-table settlement-table');
  const head = createElement('thead');
  const headRow = createElement('tr');
  ['参与者 ID', '选择', '投入', '结算返还', '净积分变化'].forEach((label) => {
    headRow.append(createElement('th', '', label));
  });
  head.append(headRow);
  const body = createElement('tbody');
  settlement.rows.forEach((item) => {
    const row = createElement('tr', item.is_winner ? 'winner-row' : 'loser-row');
    row.append(
      tableCell(item.participant_id),
      tableCell(item.side_label, item.side === 'red' ? 'text-red' : 'text-blue'),
      tableCell(String(item.points)),
      tableCell(String(item.returned_points)),
      tableCell(signedPoints(item.net_change), item.net_change >= 0 ? 'positive-points' : 'negative-points'),
    );
    body.append(row);
  });
  table.append(head, body);
  wrapper.append(table);
  section.append(wrapper);
  return section;
}

function actionButton(label, className, handler) {
  const button = createElement('button', className, label);
  button.type = 'button';
  button.addEventListener('click', handler);
  return button;
}

function buildAdminPanel(topic) {
  const section = createElement('section', 'detail-section admin-section');
  section.append(createElement('h3', '', '管理员操作'));
  section.append(createElement('p', 'detail-note', '封盘、结算和删除都需要 Render 中配置的管理员口令。'));

  const tokenLabel = createElement('label', 'admin-token-label');
  tokenLabel.append(createElement('span', '', '管理员口令'));
  const tokenInput = createElement('input');
  tokenInput.id = 'adminTokenInput';
  tokenInput.type = 'password';
  tokenInput.autocomplete = 'current-password';
  tokenInput.placeholder = '只保存在当前浏览器标签页';
  tokenInput.value = sessionStorage.getItem('prediction_admin_token') || '';
  tokenInput.addEventListener('input', () => {
    const value = tokenInput.value.trim();
    if (value) sessionStorage.setItem('prediction_admin_token', value);
    else sessionStorage.removeItem('prediction_admin_token');
  });
  tokenLabel.append(tokenInput);
  section.append(tokenLabel);

  const actions = createElement('div', 'admin-actions');

  if (topic.status === 'open') {
    actions.append(actionButton('封盘', 'management-button lock-button', async () => {
      if (!window.confirm(`确认封盘题目 #${topic.id}？封盘后不能继续提交或修改积分。`)) return;
      try {
        await adminRequest(`/api/topics/${topic.id}/lock`, { method: 'POST', body: '{}' });
        showToast('封盘成功');
        await loadTopics({ silent: true });
        await openDetails(topic.id, { preserveModal: true });
      } catch (error) {
        showToast(error.message, true);
      }
    }));
  }

  if (topic.status === 'locked') {
    actions.append(
      actionButton(`${topic.red_label}获胜并结算`, 'management-button settle-red-button', async () => {
        await settleTopic(topic, 'red');
      }),
      actionButton(`${topic.blue_label}获胜并结算`, 'management-button settle-blue-button', async () => {
        await settleTopic(topic, 'blue');
      }),
    );
  }

  actions.append(actionButton('删除题目', 'management-button delete-button', async () => {
    const confirmed = window.confirm(`确认永久删除题目 #${topic.id}“${topic.title}”及其全部参与记录？此操作无法撤销。`);
    if (!confirmed) return;
    try {
      await adminRequest(`/api/topics/${topic.id}`, { method: 'DELETE' });
      closeDetails();
      showToast('题目已删除');
      await loadTopics({ silent: true });
    } catch (error) {
      showToast(error.message, true);
    }
  }));

  section.append(actions);
  return section;
}

async function settleTopic(topic, winningSide) {
  const label = winningSide === 'red' ? topic.red_label : topic.blue_label;
  const confirmed = window.confirm(`确认以“${label}”为获胜方结算题目 #${topic.id}？结算后结果将固定。`);
  if (!confirmed) return;
  try {
    await adminRequest(`/api/topics/${topic.id}/settle`, {
      method: 'POST',
      body: JSON.stringify({ winning_side: winningSide }),
    });
    showToast(`结算成功：${label}获胜`);
    await loadTopics({ silent: true });
    await openDetails(topic.id, { preserveModal: true });
  } catch (error) {
    showToast(error.message, true);
  }
}

function renderDetails(topic) {
  elements.detailTopicId.textContent = `TOPIC #${topic.id}`;
  elements.detailTitle.textContent = topic.title;
  elements.detailContent.replaceChildren();

  const summary = createElement('section', 'detail-summary');
  const status = createElement('span', `status-badge ${statusClass(topic.status)}`, topic.status_label);
  const meta = createElement(
    'p',
    'detail-note',
    `创建者：${topic.creator_id} · ${topic.participant_count} 人参与 · 总积分 ${topic.total_points}`,
  );
  summary.append(status, meta);
  if (topic.winning_label) {
    summary.append(createElement('p', 'settled-banner', `结算结果：${topic.winning_label} 获胜`));
  }
  elements.detailContent.append(summary);

  const predictionsSection = createElement('section', 'detail-section');
  predictionsSection.append(
    createElement('h3', '', '参与明细'),
    createElement('p', 'detail-note', '显示每个参与者 ID 当前选择的选项及虚拟积分。'),
    buildPredictionsTable(topic),
  );
  elements.detailContent.append(predictionsSection);

  const settlementSection = buildSettlementTable(topic.settlement);
  if (settlementSection) elements.detailContent.append(settlementSection);
  elements.detailContent.append(buildAdminPanel(topic));
}

async function openDetails(topicId, { preserveModal = false } = {}) {
  state.currentDetailId = topicId;
  if (!preserveModal) {
    elements.detailTopicId.textContent = `TOPIC #${topicId}`;
    elements.detailTitle.textContent = '题目详情';
    elements.detailContent.innerHTML = '<div class="empty-state">正在读取详情……</div>';
    elements.detailModal.hidden = false;
    document.body.classList.add('modal-open');
  }
  try {
    const topic = await requestJson(`/api/topics/${topicId}/details`);
    if (state.currentDetailId === topicId) renderDetails(topic);
  } catch (error) {
    showToast(error.message, true);
    if (!preserveModal) closeDetails();
  }
}

function closeDetails() {
  state.currentDetailId = null;
  elements.detailModal.hidden = true;
  document.body.classList.remove('modal-open');
}

elements.topicForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const result = await submitForm(
    elements.topicForm,
    '/api/topics',
    (payload) => payload,
    (topic) => showToast(`题目创建成功，ID 为 ${topic.id}`),
  );
  if (result) {
    const creatorId = elements.topicForm.elements.creator_id.value;
    elements.topicForm.reset();
    elements.topicForm.elements.creator_id.value = creatorId;
    localStorage.setItem('prediction_user_id', creatorId);
    elements.topicIdInput.value = result.id;
    await loadTopics({ silent: true });
  }
});

elements.predictionForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const result = await submitForm(
    elements.predictionForm,
    '/api/predictions',
    (payload) => ({
      ...payload,
      topic_id: Number(payload.topic_id),
      points: Number(payload.points),
    }),
    (data) => showToast(data.action === 'updated' ? '已更新你的选择' : '积分提交成功'),
  );
  if (result) {
    const participantId = elements.participantInput.value;
    localStorage.setItem('prediction_user_id', participantId);
    await loadTopics({ silent: true });
  }
});

elements.refreshButton.addEventListener('click', () => loadTopics());
elements.searchInput.addEventListener('input', (event) => {
  state.search = event.target.value;
  renderTopics();
});

elements.shareButton.addEventListener('click', async () => {
  const shareData = {
    title: document.title,
    text: '群聊虚拟积分预测，点击链接参与。',
    url: window.location.href,
  };
  try {
    if (navigator.share) {
      await navigator.share(shareData);
    } else {
      await navigator.clipboard.writeText(window.location.href);
      showToast('链接已复制，可以粘贴到 QQ 群');
    }
  } catch (error) {
    if (error.name !== 'AbortError') showToast('分享失败，请复制浏览器地址', true);
  }
});

elements.closeDetailButton.addEventListener('click', closeDetails);
elements.detailModal.addEventListener('click', (event) => {
  if (event.target.matches('[data-close-modal]')) closeDetails();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !elements.detailModal.hidden) closeDetails();
});

function connectSocket() {
  clearTimeout(state.reconnectTimer);
  clearInterval(state.heartbeatTimer);

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socketUrl = `${protocol}//${window.location.host}/ws/topics`;
  setConnection('connecting', '正在连接');

  const socket = new WebSocket(socketUrl);
  state.socket = socket;

  socket.addEventListener('open', () => {
    state.reconnectDelay = 1000;
    setConnection('online', '实时连接');
    state.heartbeatTimer = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send('ping');
    }, 20000);
  });

  socket.addEventListener('message', (event) => {
    if (event.data === 'pong') return;
    try {
      const payload = JSON.parse(event.data);
      if (payload.type === 'topics_updated' && Array.isArray(payload.topics)) {
        state.topics = payload.topics;
        renderTopics();
        if (state.currentDetailId !== null) {
          openDetails(state.currentDetailId, { preserveModal: true });
        }
      }
    } catch {
      // Ignore malformed server messages and keep the connection alive.
    }
  });

  socket.addEventListener('close', () => {
    clearInterval(state.heartbeatTimer);
    setConnection('offline', '正在重连');
    state.reconnectTimer = setTimeout(connectSocket, state.reconnectDelay);
    state.reconnectDelay = Math.min(state.reconnectDelay * 2, 15000);
  });

  socket.addEventListener('error', () => socket.close());
}

const rememberedId = localStorage.getItem('prediction_user_id');
if (rememberedId) {
  elements.participantInput.value = rememberedId;
  elements.topicForm.elements.creator_id.value = rememberedId;
}

loadTopics({ silent: true });
connectSocket();
