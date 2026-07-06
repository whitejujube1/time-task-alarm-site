window.__APP_BOOTED__ = false;

const elements = {
  notifyBtn: document.getElementById("notify-btn"),
  parseBtn: document.getElementById("parse-btn"),
  createAlarmsBtn: document.getElementById("create-alarms-btn"),
  fileInput: document.getElementById("file-input"),
  cameraInput: document.getElementById("camera-input"),
  textInput: document.getElementById("text-input"),
  fileList: document.getElementById("file-list"),
  status: document.getElementById("status"),
  permissionTip: document.getElementById("permission-tip"),
  recordMeta: document.getElementById("record-meta"),
  scheduleList: document.getElementById("schedule-list"),
  extractedText: document.getElementById("extracted-text"),
  alarmList: document.getElementById("alarm-list"),
  toast: document.getElementById("toast"),
};

const state = {
  selectedFiles: [],
  currentItems: [],
  currentRecordId: null,
  alarms: [],
  toastTimer: null,
};

function setStatus(message) {
  elements.status.textContent = message;
}

function showToast(message) {
  clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.remove("hidden");
  state.toastTimer = setTimeout(() => {
    elements.toast.classList.add("hidden");
  }, 2200);
}

function renderFiles() {
  if (!state.selectedFiles.length) {
    elements.fileList.textContent = "当前没有选择文件。";
    return;
  }

  elements.fileList.innerHTML = state.selectedFiles
    .map((file) => `• ${file.name} (${Math.max(1, Math.round(file.size / 1024))} KB)`)
    .join("<br>");
}

function collectFiles() {
  const files = [
    ...Array.from(elements.fileInput.files || []),
    ...Array.from(elements.cameraInput.files || []),
  ];
  state.selectedFiles = files;
  renderFiles();
}

function renderItems() {
  if (!state.currentItems.length) {
    elements.scheduleList.textContent = "还没有识别结果。";
    return;
  }

  elements.scheduleList.innerHTML = state.currentItems
    .map(
      (item, index) =>
        `${index + 1}. ${item.datetime} | ${item.title} | 提前 ${item.reminderMinutesBefore} 分钟`
    )
    .join("<br>")
    .replaceAll("<", "&lt;");
}

function renderAlarms() {
  if (!state.alarms.length) {
    elements.alarmList.textContent = "还没有闹钟。";
    return;
  }

  elements.alarmList.innerHTML = state.alarms
    .map(
      (alarm, index) =>
        `${index + 1}. ${alarm.title} | 状态: ${alarm.status} | 提醒时间: ${alarm.remindAt}`
    )
    .join("<br>")
    .replaceAll("<", "&lt;");
}

async function loadBootstrap() {
  const response = await fetch("/api/bootstrap");
  const data = await response.json();
  state.alarms = data.alarms || [];
  renderAlarms();
}

async function handleNotify() {
  showToast("按钮已点击");
  setStatus("你点击了：开启提醒权限");

  if (!("Notification" in window)) {
    elements.permissionTip.textContent = "当前浏览器不支持 Notification API。";
    return;
  }

  const permission = await Notification.requestPermission();
  elements.permissionTip.textContent = `通知权限结果：${permission}`;
  setStatus(`权限处理完成：${permission}`);
}

async function handleParse() {
  showToast("开始识别");
  setStatus("你点击了：开始识别时间安排");
  elements.parseBtn.disabled = true;
  elements.parseBtn.textContent = "正在识别...";

  try {
    collectFiles();
    const text = elements.textInput.value.trim();
    if (!state.selectedFiles.length && !text) {
      throw new Error("请先上传文件、拍照或粘贴文本。");
    }

    const formData = new FormData();
    state.selectedFiles.forEach((file) => formData.append("files", file));
    if (text) {
      formData.append("text", text);
    }

    const response = await fetch("/api/parse", {
      method: "POST",
      body: formData,
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "解析失败");
    }

    state.currentRecordId = data.record.id;
    state.currentItems = data.record.items || [];
    elements.recordMeta.textContent = `记录ID: ${data.record.id}；识别条数: ${state.currentItems.length}`;
    elements.extractedText.textContent = data.record.extractedText || "";
    renderItems();
    setStatus(`识别完成，共识别 ${state.currentItems.length} 条时间安排`);
    showToast("识别完成");
  } catch (error) {
    setStatus(`识别失败：${error.message}`);
  } finally {
    elements.parseBtn.disabled = false;
    elements.parseBtn.textContent = "2. 开始识别时间安排";
  }
}

async function handleCreateAlarms() {
  showToast("开始保存闹钟");
  setStatus("你点击了：保存全部闹钟");
  elements.createAlarmsBtn.disabled = true;
  elements.createAlarmsBtn.textContent = "正在保存...";

  try {
    if (!state.currentItems.length) {
      throw new Error("当前没有识别结果，不能创建闹钟。");
    }

    const response = await fetch("/api/alarms/bulk", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ items: state.currentItems }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "保存闹钟失败");
    }

    state.alarms = data.alarms || [];
    renderAlarms();
    setStatus(`保存完成，当前共有 ${state.alarms.length} 条闹钟`);
    showToast("闹钟已保存");
  } catch (error) {
    setStatus(`保存失败：${error.message}`);
  } finally {
    elements.createAlarmsBtn.disabled = false;
    elements.createAlarmsBtn.textContent = "3. 保存全部闹钟";
  }
}

function bind() {
  elements.notifyBtn.addEventListener("click", () => {
    handleNotify().catch((error) => {
      setStatus(`权限处理异常：${error.message}`);
    });
  });

  elements.parseBtn.addEventListener("click", () => {
    handleParse().catch((error) => {
      setStatus(`识别异常：${error.message}`);
    });
  });

  elements.createAlarmsBtn.addEventListener("click", () => {
    handleCreateAlarms().catch((error) => {
      setStatus(`保存异常：${error.message}`);
    });
  });

  elements.fileInput.addEventListener("change", () => {
    collectFiles();
    setStatus("文件选择完成，可以开始识别。");
  });

  elements.cameraInput.addEventListener("change", () => {
    collectFiles();
    setStatus("拍照文件选择完成，可以开始识别。");
  });
}

async function init() {
  bind();
  await loadBootstrap();
  window.__APP_BOOTED__ = true;
  setStatus("页面脚本已加载。现在点击任意按钮都应该有反应。");
  elements.permissionTip.textContent = "如果按钮仍然无响应，说明浏览器没有执行这份新脚本。";
  showToast("调试版已加载");
}

init().catch((error) => {
  setStatus(`初始化失败：${error.message}`);
});
