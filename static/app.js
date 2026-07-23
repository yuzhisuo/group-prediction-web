'use strict';

const state = {
  topics: [],
  search: '',
  socket: null,
  reconnectTimer: null,
  heartbeatTimer: null,
  reconnectDelay: 1000,
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
};

let toastTimer = null;

function showToast(message, isError = false) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle('error', isError);
  elements.toast.classList.add('show');
  toastTimer = setTimeout(() => elements.toast.classList.remove('show'), 2600);
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

function selectTopic(topic, side) {
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

  const header = createElement('div', 'topic-card-header');
  const titleBlock = createElement('div');
  titleBlock.append(createElement('div', 'topic-id', `TOPIC #${topic.id}`));
  titleBlock.append(createElement('h3', 'topic-title', topic.title));
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

  const actions = createElement('div', 'topic-actions');
  const redButton = createElement('button', 'side-pick-button red', `选择 ${topic.red_label}`);
  redButton.type = 'button';
  redButton.addEventListener('click', () => selectTopic(topic, 'red'));
  const blueButton = createElement('button', 'side-pick-button blue', `选择 ${topic.blue_label}`);
  blueButton.type = 'button';
  blueButton.addEventListener('click', () => selectTopic(topic, 'blue'));
  actions.append(redButton, blueButton);

  card.append(header, scoreArea, metrics, actions);
  return card;
}

function renderTopics() {
  const keyword = state.search.trim().toLowerCase();
  const topics = state.topics.filter((topic) => {
    if (!keyword) return true;
    return String(topic.id).includes(keyword)
      || topic.title.toLowerCase().includes(keyword)
      || topic.red_label.toLowerCase().includes(keyword)
      || topic.blue_label.toLowerCase().includes(keyword);
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
