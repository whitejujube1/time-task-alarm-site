const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs/promises");
const fsSync = require("fs");
const Tesseract = require("tesseract.js");
const { PDFParse } = require("pdf-parse");
const mammoth = require("mammoth");
const WordExtractor = require("word-extractor");
const XLSX = require("xlsx");

const app = express();
const port = process.env.PORT || 3000;
const appVersion = "calendar-flow-restored-2026-06-23-01";
const wordExtractor = new WordExtractor();
const dataRoot = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, "data");

const baseDir = __dirname;
const publicDir = path.join(baseDir, "public");
const uploadDir = path.join(baseDir, "uploads");
const dataDir = dataRoot;
const alarmsFile = path.join(dataDir, "alarms.json");
const recordsFile = path.join(dataDir, "records.json");

for (const dir of [uploadDir, dataDir]) {
  if (!fsSync.existsSync(dir)) {
    fsSync.mkdirSync(dir, { recursive: true });
  }
}

const upload = multer({
  dest: uploadDir,
  limits: {
    fileSize: 20 * 1024 * 1024,
    files: 20,
  },
});

let alarms = [];
let records = [];
const calendarFiles = new Map();
const sseClients = new Set();

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));
app.use((req, res, next) => {
  if (
    req.path === "/" ||
    req.path.endsWith(".js") ||
    req.path.endsWith(".css") ||
    req.path.endsWith(".html") ||
    req.path.endsWith(".webmanifest") ||
    req.path.endsWith("sw.js")
  ) {
    res.setHeader("Cache-Control", "no-store");
  }
  next();
});
app.use(express.static(publicDir));

app.get("/healthz", (req, res) => {
  res.json({
    ok: true,
    version: appVersion,
    time: new Date().toISOString(),
  });
});

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

function pad(value) {
  return String(value).padStart(2, "0");
}

function createId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function countCjk(value) {
  return (String(value).match(/[\u4e00-\u9fff]/g) || []).length;
}

function normalizeUploadedFileName(name) {
  const original = String(name || "");
  const decoded = Buffer.from(original, "latin1").toString("utf8");
  if (countCjk(decoded) > countCjk(original)) {
    return decoded;
  }
  return original;
}

function toIsoLocal(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromIsoLocal(value) {
  const matched = String(value).match(
    /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T(?<hour>\d{2}):(?<minute>\d{2})$/
  );

  if (!matched) {
    return new Date(value);
  }

  const { year, month, day, hour, minute } = matched.groups;
  return new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    0,
    0
  );
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function readJson(filePath, fallback) {
  if (!fsSync.existsSync(filePath)) {
    return clone(fallback);
  }

  try {
    const content = await fs.readFile(filePath, "utf8");
    return JSON.parse(content);
  } catch {
    return clone(fallback);
  }
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

function emitEvent(type, payload) {
  const data = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    client.write(data);
  }
}

function weekdayOffset(targetDay) {
  const today = new Date().getDay();
  const normalizedToday = today === 0 ? 7 : today;
  const offset = targetDay - normalizedToday;
  return offset >= 0 ? offset : offset + 7;
}

function parseWeekdayDate(line, baseDate) {
  const weekdayMatch = line.match(/(?:周|星期)([一二三四五六日天])/);
  if (!weekdayMatch) {
    return null;
  }

  const map = {
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    日: 7,
    天: 7,
  };

  const timeMatch = line.match(/(上午|中午|下午|晚上)?\s*(\d{1,2})(?:[:：点时](\d{1,2}))?/);
  if (!timeMatch) {
    return null;
  }

  let hour = Number(timeMatch[2]);
  const minute = Number(timeMatch[3] || 0);
  const period = timeMatch[1] || "";
  if ((period === "下午" || period === "晚上") && hour < 12) {
    hour += 12;
  }

  const next = new Date(baseDate);
  next.setDate(next.getDate() + weekdayOffset(map[weekdayMatch[1]]));
  next.setHours(hour, minute, 0, 0);
  return next;
}

function parseRelativeDate(line, baseDate) {
  const timeMatch = line.match(/(上午|中午|下午|晚上)?\s*(\d{1,2})(?:[:：点时](\d{1,2}))?/);
  if (!timeMatch) {
    return null;
  }

  let hour = Number(timeMatch[2]);
  const minute = Number(timeMatch[3] || 0);
  const period = timeMatch[1] || "";
  if ((period === "下午" || period === "晚上") && hour < 12) {
    hour += 12;
  }

  const date = new Date(baseDate);
  if (line.includes("后天")) {
    date.setDate(date.getDate() + 2);
  } else if (line.includes("明天")) {
    date.setDate(date.getDate() + 1);
  }
  date.setHours(hour, minute, 0, 0);
  return date;
}

function parseAbsoluteDate(line, baseDate) {
  const patterns = [
    /(?:(\d{4})年\s*)?(\d{1,2})月\s*(\d{1,2})[日号]?\s*(?:\((?:周|星期)[一二三四五六日天]\))?\s*(上午|中午|下午|晚上)?\s*(\d{1,2})(?:[:：](\d{1,2})|[点时](\d{1,2})?分?)/,
    /(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{1,2})/,
    /(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{1,2})/,
  ];

  for (const pattern of patterns) {
    const matched = line.match(pattern);
    if (!matched) {
      continue;
    }

    if (pattern === patterns[1] || pattern === patterns[2]) {
      const date = new Date(
        Number(matched[1]),
        Number(matched[2]) - 1,
        Number(matched[3]),
        Number(matched[4]),
        Number(matched[5]),
        0,
        0
      );
      if (isValidDateTime(date, matched[1], matched[2], matched[3], matched[4], matched[5])) {
        return { date, matchedText: matched[0] };
      }
      continue;
    }

    const year = matched[1] ? Number(matched[1]) : baseDate.getFullYear();
    const month = Number(matched[2]) - 1;
    const day = Number(matched[3]);
    const period = matched[4] || "";
    let hour = Number(matched[5]);
    const minute = Number(matched[6] || matched[7] || 0);

    if ((period === "下午" || period === "晚上") && hour < 12) {
      hour += 12;
    }

    const date = new Date(year, month, day, hour, minute, 0, 0);
    if (isValidDateTime(date, year, month + 1, day, hour, minute)) {
      return { date, matchedText: matched[0] };
    }
  }

  return null;
}

function isValidDateTime(date, year, month, day, hour, minute) {
  return (
    !Number.isNaN(date.getTime()) &&
    date.getFullYear() === Number(year) &&
    date.getMonth() + 1 === Number(month) &&
    date.getDate() === Number(day) &&
    date.getHours() === Number(hour) &&
    date.getMinutes() === Number(minute)
  );
}

function isValidDateOnly(date, year, month, day) {
  return (
    !Number.isNaN(date.getTime()) &&
    date.getFullYear() === Number(year) &&
    date.getMonth() + 1 === Number(month) &&
    date.getDate() === Number(day)
  );
}

function hasScheduleKeyword(line) {
  return /(截止|递交|提交|报价截止|报名|开标|投标截止|响应截止|付款|支付|工期|合同签订|合同时间|合同截止时间|验收|初验|终验|试运行|质保|服务周期|完成|办理|到期|提醒|会议|评审|考试|预约|巡检|维修|维保|meeting|deadline|submit|review|exam|appointment)/i.test(line);
}

function isNoiseLine(line) {
  if (/(合同|截止|到期|巡检|维修|维保|服务周期)/.test(line)) {
    return false;
  }

  return (
    /￥|人民币|总计|小写|大写|单价|总价|合价|报价一览表/.test(line) ||
    /电压|电流|温度|湿度|电池|容量|功率|风量|冷量|Hz|V|kW|kg|mm|℃|RH|m3|Pa|Ah|ms|h后/.test(line)
  );
}

function parseDateOnly(line, baseDate) {
  if (!hasScheduleKeyword(line) || isNoiseLine(line)) {
    return null;
  }

  const patterns = [
    /(?:(\d{4})年)?\s*(\d{1,2})月\s*(\d{1,2})[日号]?/,
    /(\d{4})-(\d{1,2})-(\d{1,2})/,
    /(\d{4})\/(\d{1,2})\/(\d{1,2})/,
  ];

  for (const pattern of patterns) {
    const matched = line.match(pattern);
    if (!matched) {
      continue;
    }

    const year = matched[1] ? Number(matched[1]) : baseDate.getFullYear();
    const month = Number(matched[2]) - 1;
    const day = Number(matched[3]);
    const hour = /(截止|递交|提交|报价|报名|前|之前|以内|内)/.test(line) ? 18 : 9;
    const date = new Date(year, month, day, hour, 0, 0, 0);
    if (isValidDateOnly(date, year, month + 1, day)) {
      return { date, matchedText: matched[0] };
    }
  }

  return null;
}

function lastDayOfMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function parseYearMonthValue(value, baseDate) {
  const rangeMatched = String(value).match(
    /(?:(\d{4})年\s*)?(\d{1,2})月\s*[-至到~—－]\s*(?:(\d{4})年\s*)?(\d{1,2})月/
  );
  if (rangeMatched) {
    const startYear = rangeMatched[1] ? Number(rangeMatched[1]) : baseDate.getFullYear();
    const year = rangeMatched[3] ? Number(rangeMatched[3]) : startYear;
    const month = Number(rangeMatched[4]);
    return { year, month, matchedText: rangeMatched[0] };
  }

  const matched = String(value).match(/(?:(\d{4})年\s*)?(\d{1,2})月/);
  if (!matched) {
    return null;
  }

  return {
    year: matched[1] ? Number(matched[1]) : baseDate.getFullYear(),
    month: Number(matched[2]),
    matchedText: matched[0],
  };
}

function parseMonthOnly(line, baseDate) {
  if (!hasScheduleKeyword(line) || isNoiseLine(line)) {
    return null;
  }

  const fieldMatches = Array.from(
    String(line).matchAll(/([^|：:]{0,12}(?:合同截止时间|截止时间|到期时间|维修时间|巡检时间|合同时间|服务周期)[^|：:]*)[：:]\s*([^|]+)/g)
  );
  const fieldPriority = ["合同截止时间", "截止时间", "到期时间", "维修时间", "巡检时间", "合同时间", "服务周期"];

  const candidates = fieldMatches
    .map((matched) => {
      const field = matched[1];
      const parsed = parseYearMonthValue(matched[2], baseDate);
      if (!parsed) {
        return null;
      }
      const priority = fieldPriority.findIndex((key) => field.includes(key));
      return {
        ...parsed,
        priority: priority === -1 ? fieldPriority.length : priority,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.priority - b.priority);

  const parsed = candidates[0] || parseYearMonthValue(line, baseDate);
  if (!parsed) {
    return null;
  }

  const day = lastDayOfMonth(parsed.year, parsed.month);
  const date = new Date(parsed.year, parsed.month - 1, day, 18, 0, 0, 0);
  if (!isValidDateOnly(date, parsed.year, parsed.month, day)) {
    return null;
  }

  return {
    date,
    matchedText: parsed.matchedText,
    titlePrefix: "月份日期（原文只写到月份，默认该月最后一天18:00）：",
  };
}

function addBusinessDays(date, days) {
  const next = new Date(date);
  let remaining = days;
  while (remaining > 0) {
    next.setDate(next.getDate() + 1);
    const day = next.getDay();
    if (day !== 0 && day !== 6) {
      remaining -= 1;
    }
  }
  return next;
}

function parseRelativeDeadline(line, baseDate) {
  const trialMatched = line.match(/(\d{1,3})\s*个?\s*(工作日|日|天|个月|月|年).*?后/);
  const matched = line.match(/后\s*(\d{1,3})\s*个?\s*(工作日|日|天|个月|月|年)内?/);
  const candidate =
    /试运行|质保|运维|服务周期/.test(line) && trialMatched ? trialMatched : matched;

  if (!candidate || !/(完成|支付|启动|提交|递交|办理|验收|付款|试运行|工期|质保|运维|服务周期)/.test(line)) {
    return null;
  }

  const amount = Number(candidate[1]);
  const unit = candidate[2];
  const date = new Date(baseDate);

  if (unit === "工作日") {
    const next = addBusinessDays(date, amount);
    date.setTime(next.getTime());
  } else if (unit === "日" || unit === "天") {
    date.setDate(date.getDate() + amount);
  } else if (unit === "个月" || unit === "月") {
    date.setMonth(date.getMonth() + amount);
  } else if (unit === "年") {
    date.setFullYear(date.getFullYear() + amount);
  }

  date.setHours(18, 0, 0, 0);
  return {
    date,
    matchedText: candidate[0],
    titlePrefix: "相对期限（按今天估算；原文未写具体时间，默认18:00；需确认起算日期）：",
  };
}

function normalizeTitle(line, matchedText) {
  return line
    .replace(matchedText, "")
    .replace(/(?:^|\s*\|\s*)[^|：:]+[：:]\s*(?=\||$)/g, " | ")
    .replace(/\s*\|\s*/g, " | ")
    .replace(/(?:\|\s*){2,}/g, "| ")
    .replace(/^\s*\|\s*|\s*\|\s*$/g, "")
    .replace(/^[\-\d.\s、]+/, "")
    .replace(/[：:]\s*$/, "")
    .trim() || "未命名待办";
}

function extractScheduleItems(text) {
  const rawLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const lines = rawLines.map((line, index) => {
    const previous = rawLines[index - 1] || "";
    const next = rawLines[index + 1] || "";
    return {
      original: line,
      context: [previous, line, next].filter(Boolean).join(" "),
    };
  });

  const baseDate = new Date();
  baseDate.setSeconds(0, 0);

  const items = [];

  for (const entry of lines) {
    const line = entry.original;
    const contextLine = entry.context;
    const lineHasDate =
      /(?:(?:\d{4}年\s*)?\d{1,2}月(?:\s*\d{1,2}[日号]?)?)|(?:\d{4}[-/]\d{1,2}[-/]\d{1,2})/.test(line);
    const lineHasDateTime =
      /(?:(?:\d{4}年\s*)?\d{1,2}月\s*\d{1,2}[日号]?.{0,12}\d{1,2}(?:[:：点时]\d{1,2})?)|(?:\d{4}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{1,2})/.test(line);
    const shouldParseFreely = /(今天|明天|后天|周|星期)/.test(line);
    const shouldParseByKeyword = hasScheduleKeyword(contextLine) && !isNoiseLine(contextLine);
    if (!lineHasDate && !shouldParseFreely && !shouldParseByKeyword) {
      continue;
    }

    let parsed = parseAbsoluteDate(line, baseDate);
    let date = parsed ? parsed.date : null;
    let matchedText = parsed ? parsed.matchedText : "";
    let titlePrefix = parsed ? parsed.titlePrefix || "" : "";

    if (!date) {
      parsed = parseDateOnly(line, baseDate);
      date = parsed ? parsed.date : null;
      matchedText = parsed ? parsed.matchedText : "";
      titlePrefix = parsed ? parsed.titlePrefix || "" : "";
    }

    if (!date) {
      parsed = parseMonthOnly(line, baseDate);
      date = parsed ? parsed.date : null;
      matchedText = parsed ? parsed.matchedText : "";
      titlePrefix = parsed ? parsed.titlePrefix || "" : "";
    }

    if (!date && /(今天|明天|后天)/.test(line)) {
      date = parseRelativeDate(line, baseDate);
      matchedText =
        line.match(
          /(今天|明天|后天)\s*(上午|中午|下午|晚上)?\s*\d{1,2}(?:[:：点时]\d{1,2})?/
        )?.[0] || "";
    }

    if (!date && /(?:周|星期)[一二三四五六日天]/.test(line)) {
      date = parseWeekdayDate(line, baseDate);
      matchedText =
        line.match(
          /(?:周|星期)[一二三四五六日天]\s*(上午|中午|下午|晚上)?\s*\d{1,2}(?:[:：点时]\d{1,2})?/
        )?.[0] || "";
    }

    if (!date) {
      parsed = parseRelativeDeadline(line, baseDate);
      date = parsed ? parsed.date : null;
      matchedText = parsed ? parsed.matchedText : "";
      titlePrefix = parsed ? parsed.titlePrefix || "" : "";
    }

    if (!date || Number.isNaN(date.getTime())) {
      continue;
    }

    items.push({
      id: createId("item"),
      datetime: toIsoLocal(date),
      title: titlePrefix ? titlePrefix + line : normalizeTitle(line, matchedText),
      sourceLine: line,
      reminderMinutesBefore: titlePrefix ? 1440 : 10,
    });
  }

  const seen = new Set();
  return items
    .filter((item) => {
      const key = `${item.datetime}|${item.title}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.datetime.localeCompare(b.datetime));
}

function normalizeCellValue(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function isSpreadsheetFile(file) {
  const mimeType = file.mimetype || "";
  const ext = path.extname(file.originalname).toLowerCase();
  return (
    mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mimeType === "application/vnd.ms-excel" ||
    ext === ".xlsx" ||
    ext === ".xls" ||
    ext === ".xlsm"
  );
}

function looksLikeHeaderRow(row) {
  const cells = row.map(normalizeCellValue).filter(Boolean);
  const joined = cells.join(" ");
  const keywordCount = ["单位", "内容", "合同价格", "合同时间", "合同截止时间", "巡检", "维修"]
    .filter((keyword) => joined.includes(keyword)).length;
  return cells.length >= 3 && keywordCount >= 2;
}

function excelRowsToText(rows) {
  const lines = [];
  let headers = [];

  for (const row of rows) {
    const cells = row.map(normalizeCellValue);
    const nonEmpty = cells.filter(Boolean);
    if (!nonEmpty.length) {
      continue;
    }

    if (looksLikeHeaderRow(cells)) {
      headers = cells;
      lines.push(nonEmpty.join(" "));
      continue;
    }

    if (headers.length) {
      const pairs = cells
        .map((cell, index) => {
          if (!cell) {
            return "";
          }
          const header = headers[index] || `第${index + 1}列`;
          return `${header || `第${index + 1}列`}:${cell}`;
        })
        .filter(Boolean);

      if (pairs.length) {
        lines.push(pairs.join(" | "));
      }
      continue;
    }

    lines.push(nonEmpty.join(" "));
  }

  return lines.join("\n");
}

function parseExcelSerialDate(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 20000 || numeric > 80000) {
    return null;
  }

  const parsed = XLSX.SSF.parse_date_code(numeric);
  if (!parsed || !parsed.y || !parsed.m || !parsed.d) {
    return null;
  }

  return new Date(parsed.y, parsed.m - 1, parsed.d, parsed.H || 18, parsed.M || 0, 0, 0);
}

function cellLooksDateFormatted(cell) {
  return /[ymd年月日]/i.test(String(cell?.z || cell?.w || ""));
}

function parseTableDateValues(value, baseDate, options = {}) {
  const text = normalizeCellValue(value);
  if (!text) {
    if (options.rawValue === undefined || !options.allowSerialDate) {
      return [];
    }

    const serialDate = parseExcelSerialDate(options.rawValue);
    return serialDate
      ? [{
          date: serialDate,
          matchedText: String(options.rawValue),
          note: "Excel数字日期，已自动转换",
        }]
      : [];
  }

  const results = [];
  const addDate = (date, matchedText, note) => {
    if (!Number.isNaN(date.getTime())) {
      results.push({ date, matchedText, note });
    }
  };

  for (const matched of text.matchAll(
    /(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})[日号]?\s*(?:(上午|中午|下午|晚上)?\s*(\d{1,2})(?:[:：点时](\d{1,2}))?)?/g
  )) {
    let hour = Number(matched[5] || 18);
    const minute = Number(matched[6] || 0);
    const period = matched[4] || "";
    if ((period === "下午" || period === "晚上") && hour < 12) {
      hour += 12;
    }
    const date = new Date(
      Number(matched[1]),
      Number(matched[2]) - 1,
      Number(matched[3]),
      hour,
      minute,
      0,
      0
    );
    if (isValidDateOnly(date, matched[1], matched[2], matched[3])) {
      addDate(date, matched[0], matched[5] ? "" : "原文未写具体时间，默认18:00");
    }
  }

  for (const matched of text.matchAll(
    /(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:\s+(\d{1,2}):(\d{1,2}))?/g
  )) {
    const hour = Number(matched[4] || 18);
    const minute = Number(matched[5] || 0);
    const date = new Date(
      Number(matched[1]),
      Number(matched[2]) - 1,
      Number(matched[3]),
      hour,
      minute,
      0,
      0
    );
    if (isValidDateOnly(date, matched[1], matched[2], matched[3])) {
      addDate(date, matched[0], matched[4] ? "" : "原文未写具体时间，默认18:00");
    }
  }

  if (results.length) {
    return results;
  }

  if (options.allowSerialDate) {
    const serialDate = parseExcelSerialDate(options.rawValue ?? text);
    if (serialDate) {
      return [{
        date: serialDate,
        matchedText: text,
        note: "Excel数字日期，已自动转换",
      }];
    }
  }

  const rangeParsed = parseYearMonthValue(text, baseDate);
  if (rangeParsed) {
    const day = lastDayOfMonth(rangeParsed.year, rangeParsed.month);
    addDate(
      new Date(rangeParsed.year, rangeParsed.month - 1, day, 18, 0, 0, 0),
      rangeParsed.matchedText,
      "原文只写到月份，默认该月最后一天18:00"
    );
  }

  return results;
}

function rowLabelFromPairs(pairs, fallback) {
  const preferred = ["单位", "项目", "公司", "名称", "内容", "设备", "合同名称"];
  const picked = preferred
    .map((keyword) => pairs.find((pair) => pair.header.includes(keyword) && pair.value))
    .filter(Boolean)
    .slice(0, 2)
    .map((pair) => `${pair.header}:${pair.value}`);
  return picked.length ? picked.join(" | ") : fallback;
}

function isExcelServiceTimeHeader(header) {
  return /(巡检时间|维修时间)/.test(String(header || ""));
}

function extractScheduleItemsFromExcelRows(rows, sheetName) {
  const baseDate = new Date();
  baseDate.setSeconds(0, 0);

  const items = [];
  let headers = [];
  let section = "";

  for (const row of rows) {
    const cells = row.map(normalizeCellValue);
    const nonEmpty = cells.filter(Boolean);
    if (!nonEmpty.length) {
      continue;
    }

    if (looksLikeHeaderRow(cells)) {
      headers = cells;
      continue;
    }

    if (nonEmpty.length === 1 && !parseTableDateValues(nonEmpty[0], baseDate).length) {
      section = nonEmpty[0];
      continue;
    }

    const pairs = cells
      .map((cell, index) => ({
        header: headers[index] || `第${index + 1}列`,
        value: cell,
      }))
      .filter((pair) => pair.value);
    const sourceLine = pairs.map((pair) => `${pair.header}:${pair.value}`).join(" | ");
    const fallbackTitle = [section, sourceLine].filter(Boolean).join(" | ");
    const rowLabel = rowLabelFromPairs(pairs, fallbackTitle);

    for (const pair of pairs) {
      if (!isExcelServiceTimeHeader(pair.header)) {
        continue;
      }

      const parsedDates = parseTableDateValues(pair.value, baseDate);
      for (const parsed of parsedDates) {
        const note = parsed.note ? `（${parsed.note}）` : "";
        const sectionText = section ? `${section} | ` : "";
        items.push({
          id: createId("item"),
          datetime: toIsoLocal(parsed.date),
          title: `${sectionText}${pair.header}${note}：${pair.value} | ${rowLabel}`,
          sourceLine: `[工作表] ${sheetName} | ${sourceLine}`,
          reminderMinutesBefore: 10,
        });
      }
    }
  }

  return items;
}

function headerSuggestsDate(header) {
  const value = String(header || "");
  if (/(价格|金额|费用|单价|总价|合价)/.test(value)) {
    return false;
  }
  return /(日期|时间|截止|到期|巡检|维修|维保|服务周期)/.test(value);
}

function extractScheduleItemsFromWorksheetCells(worksheet, rows, sheetName) {
  if (!worksheet["!ref"]) {
    return [];
  }

  const baseDate = new Date();
  baseDate.setSeconds(0, 0);

  const range = XLSX.utils.decode_range(worksheet["!ref"]);
  const items = [];
  let headers = [];
  let section = "";

  for (let rowIndex = range.s.r; rowIndex <= range.e.r; rowIndex += 1) {
    const displayRow = rows[rowIndex] || [];
    const cells = displayRow.map(normalizeCellValue);
    const nonEmpty = cells.filter(Boolean);
    if (!nonEmpty.length) {
      continue;
    }

    if (looksLikeHeaderRow(cells)) {
      headers = cells;
      continue;
    }

    if (nonEmpty.length === 1 && !parseTableDateValues(nonEmpty[0], baseDate).length) {
      section = nonEmpty[0];
      continue;
    }

    const pairs = [];
    for (let colIndex = range.s.c; colIndex <= range.e.c; colIndex += 1) {
      const address = XLSX.utils.encode_cell({ r: rowIndex, c: colIndex });
      const cell = worksheet[address];
      const displayValue = normalizeCellValue(
        cell ? (cell.w !== undefined ? cell.w : cell.v) : displayRow[colIndex]
      );
      if (!displayValue) {
        continue;
      }
      pairs.push({
        header: headers[colIndex] || `第${colIndex + 1}列`,
        value: displayValue,
        cell,
      });
    }

    const sourceLine = pairs.map((pair) => `${pair.header}:${pair.value}`).join(" | ");
    const fallbackTitle = [section, sourceLine].filter(Boolean).join(" | ");
    const rowLabel = rowLabelFromPairs(pairs, fallbackTitle);

    for (const pair of pairs) {
      if (!isExcelServiceTimeHeader(pair.header)) {
        continue;
      }

      const candidates = [
        pair.value,
        pair.cell?.w,
        pair.cell?.v,
      ].filter((value, index, list) => value !== undefined && list.indexOf(value) === index);
      const allowSerialDate = headerSuggestsDate(pair.header) || cellLooksDateFormatted(pair.cell);

      for (const candidate of candidates) {
        const parsedDates = parseTableDateValues(candidate, baseDate, {
          rawValue: pair.cell?.v,
          allowSerialDate,
        });

        for (const parsed of parsedDates) {
          const note = parsed.note ? `（${parsed.note}）` : "";
          const sectionText = section ? `${section} | ` : "";
          items.push({
            id: createId("item"),
            datetime: toIsoLocal(parsed.date),
            title: `${sectionText}${pair.header}${note}：${pair.value} | ${rowLabel}`,
            sourceLine: `[工作表] ${sheetName} | ${sourceLine}`,
            reminderMinutesBefore: 10,
          });
        }
      }
    }
  }

  return items;
}

function dedupeScheduleItems(items) {
  const seen = new Set();
  return items
    .filter((item) => {
      const key = `${item.datetime}|${item.title}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.datetime.localeCompare(b.datetime));
}

function extractExcelTextAndItems(file) {
  const workbook = XLSX.readFile(file.path);
  const textParts = [];
  const items = [];

  for (const sheetName of workbook.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
      header: 1,
      raw: false,
      defval: "",
    });
    textParts.push(`[工作表] ${sheetName}\n${excelRowsToText(rows)}`);
    items.push(...extractScheduleItemsFromExcelRows(rows, sheetName));
    items.push(...extractScheduleItemsFromWorksheetCells(workbook.Sheets[sheetName], rows, sheetName));
  }

  return {
    text: textParts.join("\n\n"),
    items: dedupeScheduleItems(items),
  };
}

// 文件解析模块：按不同格式抽取纯文本，后续统一走时间识别逻辑。
async function extractTextFromFile(file) {
  const mimeType = file.mimetype || "";
  const ext = path.extname(file.originalname).toLowerCase();

  if (mimeType.startsWith("text/") || /\.(txt|md|csv)$/i.test(file.originalname)) {
    return fs.readFile(file.path, "utf8");
  }

  if (mimeType.startsWith("image/")) {
    const result = await Tesseract.recognize(file.path, "chi_sim+eng", {
      logger: () => {},
    });
    return result.data.text;
  }

  if (mimeType === "application/pdf" || ext === ".pdf") {
    const buffer = await fs.readFile(file.path);
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      const text = (result.text || "").trim();
      if (text) {
        return text;
      }

      // 扫描版 PDF 没有可复制文字时，渲染前几页做 OCR 兜底。
      const screenshots = await parser.getScreenshot({
        first: Math.min(Number(result.total || 5), 5),
        desiredWidth: 1600,
        imageDataUrl: false,
        imageBuffer: true,
      });
      const ocrParts = [];
      for (const page of screenshots.pages || []) {
        const ocr = await Tesseract.recognize(Buffer.from(page.data), "chi_sim+eng", {
          logger: () => {},
        });
        if ((ocr.data.text || "").trim()) {
          ocrParts.push(`[PDF第${page.pageNumber}页OCR]\n${ocr.data.text}`);
        }
      }

      const ocrText = ocrParts.join("\n\n").trim();
      if (!ocrText) {
        throw new Error(
          `PDF 未提取到文字：${file.originalname}。如果这是扫描版 PDF，请尝试上传清晰图片，或换成可复制文字的 PDF。`
        );
      }
      return ocrText;
    } finally {
      await parser.destroy();
    }
  }

  if (
    mimeType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    ext === ".docx"
  ) {
    const result = await mammoth.extractRawText({ path: file.path });
    return result.value;
  }

  if (mimeType === "application/msword" || ext === ".doc") {
    const document = await wordExtractor.extract(file.path);
    return [
      document.getBody(),
      document.getHeaders(),
      document.getFooters(),
      document.getFootnotes(),
      document.getEndnotes(),
      document.getAnnotations(),
      document.getTextboxes({ includeHeadersAndFooters: false }),
    ]
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  if (isSpreadsheetFile(file)) {
    return extractExcelTextAndItems(file).text;
  }

  throw new Error(`暂不支持文件类型：${file.originalname}`);
}

function buildAlarmFromItem(item) {
  const eventTime = fromIsoLocal(item.datetime);
  const remindAt = new Date(
    eventTime.getTime() - Number(item.reminderMinutesBefore ?? 10) * 60 * 1000
  );

  return {
    id: createId("alarm"),
    itemId: item.id,
    recordId: item.recordId || "",
    title: item.title,
    datetime: item.datetime,
    sourceLine: item.sourceLine || "",
    reminderMinutesBefore: Number(item.reminderMinutesBefore ?? 10),
    remindAt: toIsoLocal(remindAt),
    status: "scheduled",
    createdAt: toIsoLocal(new Date()),
    updatedAt: toIsoLocal(new Date()),
    triggeredAt: null,
  };
}

async function saveRecords() {
  await writeJson(recordsFile, records);
}

async function saveAlarms() {
  await writeJson(alarmsFile, alarms);
}

function sanitizeItem(item) {
  return {
    id: String(item.id || createId("item")),
    recordId: String(item.recordId || ""),
    datetime: String(item.datetime || ""),
    title: String(item.title || "未命名待办"),
    sourceLine: String(item.sourceLine || ""),
    reminderMinutesBefore: Number(item.reminderMinutesBefore ?? 10),
  };
}

function getLatestRecord() {
  return records.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] || null;
}

app.get("/api/bootstrap", (req, res) => {
  res.json({
    alarms: alarms.slice().sort((a, b) => a.remindAt.localeCompare(b.remindAt)),
    latestRecord: getLatestRecord(),
    recordsCount: records.length,
  });
});

// OCR / 时间提取模块：支持批量文件与直接粘贴文本，输出结构化待办列表。
app.post("/api/parse", upload.array("files", 20), async (req, res) => {
  const files = req.files || [];
  const textParts = [];
  const textParseParts = [];
  const directItems = [];

  try {
    if ((req.body.text || "").trim()) {
      const manualText = "[手动输入]\n" + req.body.text.trim();
      textParts.push(manualText);
      textParseParts.push(manualText);
    }

    for (const file of files) {
      file.originalname = normalizeUploadedFileName(file.originalname);

      if (isSpreadsheetFile(file)) {
        const extracted = extractExcelTextAndItems(file);
        textParts.push(`[文件] ${file.originalname}\n${extracted.text}`);
        directItems.push(...extracted.items);
        continue;
      }

      const text = await extractTextFromFile(file);
      const fileText = `[文件] ${file.originalname}\n${text}`;
      textParts.push(fileText);
      textParseParts.push(fileText);
    }

    const extractedText = textParts.join("\n\n").trim();
    if (!extractedText) {
      return res.status(400).json({ error: "请至少上传一个文件，或粘贴一段文本内容。" });
    }

    const items = dedupeScheduleItems([
      ...directItems,
      ...extractScheduleItems(textParseParts.join("\n\n")),
    ]);
    const record = {
      id: createId("record"),
      createdAt: toIsoLocal(new Date()),
      sourceFiles: files.map((file) => file.originalname),
      extractedText,
      items,
    };

    records.push(record);
    await saveRecords();

    return res.json({
      message: files.length ? "文件上传并识别成功。" : "文本解析成功。",
      warning:
        items.length === 0
          ? "未识别到有效待办时间与任务，请手动补充完整日期和时间后再导出日历提醒。"
          : null,
      record,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "解析失败，请稍后重试。" });
  } finally {
    await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => {})));
  }
});

app.put("/api/records/:id", async (req, res) => {
  const record = records.find((item) => item.id === req.params.id);
  if (!record) {
    return res.status(404).json({ error: "没有找到对应的识别记录。" });
  }

  const items = Array.isArray(req.body.items) ? req.body.items.map(sanitizeItem) : [];
  record.items = items.filter((item) => !Number.isNaN(fromIsoLocal(item.datetime).getTime()));
  record.updatedAt = toIsoLocal(new Date());
  await saveRecords();

  return res.json({ message: "提取结果已保存。", record });
});

app.get("/api/alarms", (req, res) => {
  res.json({
    alarms: alarms.slice().sort((a, b) => a.remindAt.localeCompare(b.remindAt)),
  });
});

// 定时闹钟模块：将提取结果批量转换为本地闹钟记录，后续支持编辑、删除、延后和完成。
app.post("/api/alarms/bulk", async (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items.map(sanitizeItem) : [];
  if (!items.length) {
    return res.status(400).json({ error: "没有可创建闹钟的待办项。" });
  }

  const created = items
    .filter((item) => !Number.isNaN(fromIsoLocal(item.datetime).getTime()))
    .map(buildAlarmFromItem);

  alarms.push(...created);
  await saveAlarms();
  emitEvent("alarms-updated", alarms);

  return res.json({
    message: `已批量创建 ${created.length} 条闹钟。`,
    created,
    alarms: alarms.slice().sort((a, b) => a.remindAt.localeCompare(b.remindAt)),
  });
});

app.delete("/api/alarms", async (req, res) => {
  alarms = [];
  await saveAlarms();
  emitEvent("alarms-updated", alarms);
  return res.json({ message: "已清空全部闹钟。", alarms });
});

app.post("/api/alarms/clear", async (req, res) => {
  alarms = [];
  await saveAlarms();
  emitEvent("alarms-updated", alarms);
  return res.json({ message: "已清空全部闹钟。", alarms });
});

function escapeIcsText(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function toIcsDate(value) {
  const date = fromIsoLocal(value);
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "T",
    pad(date.getHours()),
    pad(date.getMinutes()),
    "00",
  ].join("");
}

function buildCalendarIcs(items) {
  const nowStamp = toIcsDate(toIsoLocal(new Date()));
  const events = items
    .filter((item) => !Number.isNaN(fromIsoLocal(item.datetime).getTime()))
    .map((item) => {
      const start = toIcsDate(item.datetime);
      const endDate = fromIsoLocal(item.datetime);
      endDate.setMinutes(endDate.getMinutes() + 30);
      const trigger = `-PT${Math.max(0, Number(item.reminderMinutesBefore ?? 10))}M`;
      return [
        "BEGIN:VEVENT",
        `UID:${item.id}@time-task-alarm-site`,
        `DTSTAMP:${nowStamp}`,
        `DTSTART:${start}`,
        `DTEND:${toIcsDate(toIsoLocal(endDate))}`,
        `SUMMARY:${escapeIcsText(item.title)}`,
        `DESCRIPTION:${escapeIcsText(item.sourceLine)}`,
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        `DESCRIPTION:${escapeIcsText(item.title)}`,
        `TRIGGER:${trigger}`,
        "END:VALARM",
        "END:VEVENT",
      ].join("\r\n");
    });

  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Time Task Alarm Site//CN",
    "X-WR-CALNAME:时间任务提醒",
    "X-WR-TIMEZONE:Asia/Shanghai",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    ...events,
    "END:VCALENDAR",
  ].join("\r\n");
}

function buildAppleRemindersIcs(items) {
  const nowStamp = toIcsDate(toIsoLocal(new Date()));
  const todos = items
    .filter((item) => !Number.isNaN(fromIsoLocal(item.datetime).getTime()))
    .map((item) => {
      const due = toIcsDate(item.datetime);
      const trigger = `-PT${Math.max(0, Number(item.reminderMinutesBefore ?? 10))}M`;
      return [
        "BEGIN:VTODO",
        `UID:${item.id}@time-task-reminders-site`,
        `DTSTAMP:${nowStamp}`,
        `CREATED:${nowStamp}`,
        `LAST-MODIFIED:${nowStamp}`,
        `DUE:${due}`,
        "STATUS:NEEDS-ACTION",
        "PRIORITY:5",
        `SUMMARY:${escapeIcsText(item.title)}`,
        `DESCRIPTION:${escapeIcsText(item.sourceLine)}`,
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        `DESCRIPTION:${escapeIcsText(item.title)}`,
        `TRIGGER:${trigger}`,
        "END:VALARM",
        "END:VTODO",
      ].join("\r\n");
    });

  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Time Task Apple Reminders Site//CN",
    "X-WR-CALNAME:时间任务提醒事项",
    "X-WR-TIMEZONE:Asia/Shanghai",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    ...todos,
    "END:VCALENDAR",
  ].join("\r\n");
}

function buildShortcutReminders(items) {
  return items
    .filter((item) => !Number.isNaN(fromIsoLocal(item.datetime).getTime()))
    .map((item) => {
      const dueDate = fromIsoLocal(item.datetime);
      const remindAt = new Date(
        dueDate.getTime() - Number(item.reminderMinutesBefore ?? 10) * 60 * 1000
      );
      return {
        title: item.title,
        notes: item.sourceLine || "",
        dueDate: toIsoLocal(dueDate).replace("T", " "),
        remindAt: toIsoLocal(remindAt).replace("T", " "),
        reminderMinutesBefore: Number(item.reminderMinutesBefore ?? 10),
      };
    });
}

function sendCalendar(res, ics, disposition = "attachment", filename = "reminders.ics") {
  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.setHeader("Content-Disposition", `${disposition}; filename="${filename}"`);
  res.setHeader("Cache-Control", "no-store");
  return res.send(ics);
}

app.post("/api/calendar.ics", (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items.map(sanitizeItem) : [];
  if (!items.length) {
    return res.status(400).send("没有可导出的提醒。");
  }

  const ics = buildCalendarIcs(items);
  return sendCalendar(res, ics, "attachment");
});

app.post("/api/calendar-file", (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items.map(sanitizeItem) : [];
  if (!items.length) {
    return res.status(400).json({ error: "没有可导出的提醒。" });
  }

  const ics = buildCalendarIcs(items);
  const id = createId("calendar");
  calendarFiles.set(id, {
    ics,
    createdAt: Date.now(),
  });

  return res.json({
    url: `/api/calendar-files/${id}.ics`,
  });
});

app.post("/api/apple-reminders-file", (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items.map(sanitizeItem) : [];
  if (!items.length) {
    return res.status(400).json({ error: "没有可导出的提醒事项。" });
  }

  const ics = buildAppleRemindersIcs(items);
  const id = createId("apple-reminders");
  calendarFiles.set(id, {
    ics,
    filename: "apple-reminders.ics",
    createdAt: Date.now(),
  });

  return res.json({
    url: `/api/calendar-files/${id}.ics`,
  });
});

app.post("/api/shortcut-reminders", (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items.map(sanitizeItem) : [];
  const reminders = buildShortcutReminders(items);
  if (!reminders.length) {
    return res.status(400).json({ error: "没有可导入快捷指令的提醒事项。" });
  }

  const id = createId("shortcut-reminders");
  calendarFiles.set(id, {
    json: reminders,
    createdAt: Date.now(),
  });

  return res.json({
    url: `/api/shortcut-reminders/${id}.json`,
  });
});

app.get("/api/shortcut-reminders/:id.json", (req, res) => {
  const stored = calendarFiles.get(req.params.id);
  if (!stored || !stored.json) {
    return res.status(404).json({ error: "快捷指令数据已过期，请重新生成。" });
  }

  res.setHeader("Cache-Control", "no-store");
  return res.json({
    reminders: stored.json,
  });
});

app.get("/api/calendar-files/:id.ics", (req, res) => {
  const stored = calendarFiles.get(req.params.id);
  if (!stored) {
    return res.status(404).send("日历文件已过期，请重新下载。");
  }

  return sendCalendar(res, stored.ics, "inline", stored.filename || "reminders.ics");
});

app.patch("/api/alarms/:id", async (req, res) => {
  const alarm = alarms.find((item) => item.id === req.params.id);
  if (!alarm) {
    return res.status(404).json({ error: "没有找到对应闹钟。" });
  }

  if (req.body.title !== undefined) {
    alarm.title = String(req.body.title || alarm.title);
  }
  if (req.body.datetime !== undefined) {
    alarm.datetime = String(req.body.datetime || alarm.datetime);
  }
  if (req.body.reminderMinutesBefore !== undefined) {
    alarm.reminderMinutesBefore = Number(req.body.reminderMinutesBefore ?? 10);
  }

  const remindAt = new Date(
    fromIsoLocal(alarm.datetime).getTime() - alarm.reminderMinutesBefore * 60 * 1000
  );
  alarm.remindAt = toIsoLocal(remindAt);
  alarm.updatedAt = toIsoLocal(new Date());

  if (req.body.status) {
    alarm.status = String(req.body.status);
  }

  await saveAlarms();
  emitEvent("alarms-updated", alarms);
  return res.json({ message: "闹钟已更新。", alarm });
});

app.post("/api/alarms/:id/snooze", async (req, res) => {
  const alarm = alarms.find((item) => item.id === req.params.id);
  if (!alarm) {
    return res.status(404).json({ error: "没有找到对应闹钟。" });
  }

  const current = fromIsoLocal(alarm.remindAt);
  current.setMinutes(current.getMinutes() + 10);
  alarm.remindAt = toIsoLocal(current);
  alarm.status = "scheduled";
  alarm.updatedAt = toIsoLocal(new Date());
  alarm.triggeredAt = null;
  await saveAlarms();
  emitEvent("alarms-updated", alarms);
  return res.json({ message: "闹钟已延后 10 分钟。", alarm });
});

app.post("/api/alarms/:id/complete", async (req, res) => {
  const alarm = alarms.find((item) => item.id === req.params.id);
  if (!alarm) {
    return res.status(404).json({ error: "没有找到对应闹钟。" });
  }

  alarm.status = "completed";
  alarm.updatedAt = toIsoLocal(new Date());
  await saveAlarms();
  emitEvent("alarms-updated", alarms);
  return res.json({ message: "闹钟已标记完成。", alarm });
});

app.post("/api/alarms/:id/close", async (req, res) => {
  const alarm = alarms.find((item) => item.id === req.params.id);
  if (!alarm) {
    return res.status(404).json({ error: "没有找到对应闹钟。" });
  }

  alarm.status = "dismissed";
  alarm.updatedAt = toIsoLocal(new Date());
  await saveAlarms();
  emitEvent("alarms-updated", alarms);
  return res.json({ message: "提醒窗口已关闭。", alarm });
});

app.delete("/api/alarms/:id", async (req, res) => {
  const before = alarms.length;
  alarms = alarms.filter((item) => item.id !== req.params.id);
  if (alarms.length === before) {
    return res.status(404).json({ error: "没有找到对应闹钟。" });
  }

  await saveAlarms();
  emitEvent("alarms-updated", alarms);
  return res.json({ message: "闹钟已删除。" });
});

app.use((error, req, res, next) => {
  console.error("Unhandled request error:", error);
  res.status(500).json({
    error: error && error.message ? error.message : "服务器内部错误",
  });
});

app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  sseClients.add(res);
  res.write(`event: init\ndata: ${JSON.stringify({ ok: true })}\n\n`);

  req.on("close", () => {
    sseClients.delete(res);
  });
});

setInterval(async () => {
  let changed = false;
  const now = Date.now();

  for (const alarm of alarms) {
    if (alarm.status !== "scheduled") {
      continue;
    }

    if (fromIsoLocal(alarm.remindAt).getTime() <= now) {
      alarm.status = "triggered";
      alarm.triggeredAt = toIsoLocal(new Date());
      changed = true;
      emitEvent("alarm-triggered", alarm);
    }
  }

  if (changed) {
    await saveAlarms();
    emitEvent("alarms-updated", alarms);
  }
}, 5000);

Promise.all([
  readJson(alarmsFile, []),
  readJson(recordsFile, []),
]).then(([savedAlarms, savedRecords]) => {
  alarms = savedAlarms;
  records = savedRecords;
  app.listen(port, "0.0.0.0", () => {
    console.log(`Time task alarm site listening on http://0.0.0.0:${port}`);
  });
});
