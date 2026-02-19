// Pi-Browser Extension - Background Service Worker
let ws = null;
let connectedTabId = null;
let isDebugging = false;

// 서비스 워커 활성 유지를 위한 알람
chrome.alarms.create("keepAlive", { periodInMinutes: 0.25 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepAlive") {
    // WebSocket 연결 확인 및 핑 전송 (서비스 워커 활성 유지)
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "ping", timestamp: Date.now() }));
    } else {
      connect();
    }
  }
});

// WebSocket 서버에 연결
function connect() {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  console.log("[Pi-Browser] WebSocket 연결 시도...");
  ws = new WebSocket("ws://localhost:9876");

  ws.onopen = () => {
    console.log("[Pi-Browser] WebSocket 연결됨");
    chrome.action.setBadgeText({ text: "ON" });
    chrome.action.setBadgeBackgroundColor({ color: "#4CAF50" });
  };

  ws.onclose = () => {
    console.log("[Pi-Browser] WebSocket 연결 끊김");
    chrome.action.setBadgeText({ text: "" });
    ws = null;
    // 5초 후 재연결 시도
    setTimeout(connect, 5000);
  };

  ws.onerror = (error) => {
    console.log("[Pi-Browser] WebSocket 에러:", error);
  };

  ws.onmessage = async (event) => {
    let msgId = null;
    try {
      const message = JSON.parse(event.data);
      msgId = message.id;
      console.log("[Pi-Browser] 명령 수신:", message.command, message.params);
      const result = await handleCommand(message);
      console.log("[Pi-Browser] 명령 완료:", message.command);
      ws.send(JSON.stringify({ id: msgId, result }));
    } catch (error) {
      console.error("[Pi-Browser] 명령 처리 에러:", error.message);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ id: msgId, error: error.message }));
      }
    }
  };
}

// 명령 처리
async function handleCommand(message) {
  const { command, params } = message;

  switch (command) {
    case "getTabs":
      return await getTabs();

    case "selectTab":
      return await selectTab(params.tabId);

    case "navigate":
      return await navigate(params.url);

    case "screenshot":
      return await takeScreenshot();

    case "snapshot":
      return await getSnapshot();

    case "click":
      return await clickElement(params.selector);

    case "fill":
      return await fillElement(params.selector, params.value);

    case "press":
      return await pressKey(params.key);

    case "scroll":
      return await scroll(params.direction, params.amount);

    case "getText":
      return await getPageText();

    case "evaluate":
      return await evaluateScript(params.script);

    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

// 탭 목록 가져오기
async function getTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.map((tab) => ({
    id: tab.id,
    title: tab.title,
    url: tab.url,
    active: tab.active,
  }));
}

// 탭 선택
async function selectTab(tabId) {
  connectedTabId = tabId;
  await chrome.tabs.update(tabId, { active: true });
  return { success: true, tabId };
}

// 페이지 이동
async function navigate(url) {
  if (!connectedTabId) {
    // 새 탭 생성
    const tab = await chrome.tabs.create({ url });
    connectedTabId = tab.id;
  } else {
    await chrome.tabs.update(connectedTabId, { url });
  }

  // 페이지 로드 대기
  await waitForPageLoad();

  const tab = await chrome.tabs.get(connectedTabId);
  return { success: true, url: tab.url, title: tab.title };
}

// 페이지 로드 대기
function waitForPageLoad() {
  return new Promise((resolve) => {
    const listener = (tabId, info) => {
      if (tabId === connectedTabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 500); // 추가 대기
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    // 타임아웃
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 30000);
  });
}

// 스크린샷
async function takeScreenshot() {
  await getActiveTabId();

  const dataUrl = await chrome.tabs.captureVisibleTab(null, {
    format: "png",
  });

  return { image: dataUrl };
}

// 현재 활성 탭 ID 가져오기
async function getActiveTabId() {
  if (connectedTabId) return connectedTabId;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    connectedTabId = tab.id;
    return tab.id;
  }
  throw new Error("No active tab found");
}

// 페이지 스냅샷 (요소 정보)
async function getSnapshot() {
  const tabId = await getActiveTabId();

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const elements = [];
      const interactiveSelectors = [
        "a",
        "button",
        "input",
        "select",
        "textarea",
        '[role="button"]',
        '[role="link"]',
        '[role="textbox"]',
        '[role="checkbox"]',
        '[role="radio"]',
        '[onclick]',
        '[tabindex]',
      ];

      document.querySelectorAll(interactiveSelectors.join(",")).forEach((el, index) => {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        if (rect.top > window.innerHeight || rect.bottom < 0) return;

        const text =
          el.innerText?.trim().slice(0, 100) ||
          el.value ||
          el.placeholder ||
          el.getAttribute("aria-label") ||
          el.title ||
          "";

        elements.push({
          ref: `ref_${index}`,
          tag: el.tagName.toLowerCase(),
          type: el.type || null,
          text: text,
          role: el.getAttribute("role"),
          selector: generateSelector(el),
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        });
      });

      function generateSelector(el) {
        if (el.id) return `#${el.id}`;
        if (el.name) return `[name="${el.name}"]`;

        let path = el.tagName.toLowerCase();
        if (el.className && typeof el.className === "string") {
          const classes = el.className.trim().split(/\s+/).slice(0, 2).join(".");
          if (classes) path += `.${classes}`;
        }
        return path;
      }

      return elements;
    },
  });

  return { elements: results[0]?.result || [] };
}

// 요소 클릭 (실제 마우스 이벤트 시뮬레이션)
async function clickElement(selector) {
  const tabId = await getActiveTabId();

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error(`Element not found: ${sel}`);

      const rect = el.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;

      // 마우스 이벤트 시퀀스
      const events = ["mousedown", "mouseup", "click"];
      for (const type of events) {
        const event = new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: x,
          clientY: y,
        });
        el.dispatchEvent(event);
      }

      return { success: true };
    },
    args: [selector],
  });

  return results[0]?.result;
}

// 요소에 입력 (React/contenteditable 호환 - execCommand 사용)
async function fillElement(selector, value) {
  const tabId = await getActiveTabId();

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel, val) => {
      // 셀렉터로 요소 찾기 또는 contenteditable 요소 찾기
      let el = document.querySelector(sel);

      // contenteditable 요소 찾기 (Threads, Facebook 등)
      if (!el) {
        el = document.querySelector('[contenteditable="true"]');
      }
      if (!el) {
        el = document.querySelector('[role="textbox"]');
      }
      if (!el) throw new Error(`Element not found: ${sel}`);

      el.focus();

      // 기존 내용 선택 후 삭제
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);

      // 텍스트 삽입
      document.execCommand('insertText', false, val);

      return { success: true };
    },
    args: [selector, value],
  });

  return results[0]?.result;
}

// 키 입력
async function pressKey(key) {
  const tabId = await getActiveTabId();

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (k) => {
      const keyMap = {
        Enter: { key: "Enter", code: "Enter", keyCode: 13 },
        Tab: { key: "Tab", code: "Tab", keyCode: 9 },
        Escape: { key: "Escape", code: "Escape", keyCode: 27 },
        ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
        ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
        Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
      };

      const keyInfo = keyMap[k] || { key: k, code: k, keyCode: k.charCodeAt(0) };
      const event = new KeyboardEvent("keydown", {
        key: keyInfo.key,
        code: keyInfo.code,
        keyCode: keyInfo.keyCode,
        bubbles: true,
      });

      document.activeElement?.dispatchEvent(event);
      return { success: true };
    },
    args: [key],
  });

  return results[0]?.result;
}

// 스크롤
async function scroll(direction, amount = 500) {
  const tabId = await getActiveTabId();

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (dir, amt) => {
      const scrollMap = {
        up: [0, -amt],
        down: [0, amt],
        left: [-amt, 0],
        right: [amt, 0],
      };
      const [x, y] = scrollMap[dir] || [0, amt];
      window.scrollBy(x, y);
      return { success: true, scrollY: window.scrollY };
    },
    args: [direction, amount],
  });

  return results[0]?.result;
}

// 페이지 텍스트 가져오기
async function getPageText() {
  const tabId = await getActiveTabId();

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      return document.body.innerText;
    },
  });

  return { text: results[0]?.result || "" };
}

// 스크립트 실행
async function evaluateScript(script) {
  const tabId = await getActiveTabId();

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (code) => {
      return eval(code);
    },
    args: [script],
  });

  return { result: results[0]?.result };
}

// 메시지 핸들러 (popup에서 상태 확인용)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "getStatus") {
    sendResponse({ connected: ws && ws.readyState === WebSocket.OPEN });
  }
  return true;
});

// Extension 설치/업데이트 시 연결
chrome.runtime.onInstalled.addListener(() => {
  console.log("[Pi-Browser] Extension 설치/업데이트됨");
  connect();
});

// 브라우저 시작 시 연결
chrome.runtime.onStartup.addListener(() => {
  console.log("[Pi-Browser] 브라우저 시작됨");
  connect();
});

// 시작 시 연결 시도
connect();
