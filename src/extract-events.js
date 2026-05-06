const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { createWorker } = require("tesseract.js");

const inputPath = process.argv[2] || "timetable.png";

const TMP_DIR = path.join(__dirname, "..", "tmp");
fs.mkdirSync(TMP_DIR, { recursive: true });

const CONFIG = {
  columns: [
    { day: "월", x1: 59, x2: 203 },
    { day: "화", x1: 205, x2: 349 },
    { day: "수", x1: 350, x2: 495 },
    { day: "목", x1: 496, x2: 640 },
    { day: "금", x1: 641, x2: 783 },
  ],

  // 이미지 기준: 8시 라인 y좌표
  startHour: 8,
  yStart: 174,
  hourHeight: 92.5,

  scanY1: 174,
  scanY2: 1098,

  // 컬럼 안에서 색상 픽셀 비율이 이 이상이면 수업 블록 row로 판단
  rowColorRatio: 0.12,

  // 너무 짧은 색상 덩어리 제거
  minSegmentHeight: 30,

  // crop 여백
  cropPaddingX: 2,
  cropPaddingY: 2,
};

async function loadRgb(imagePath) {
  const { data, info } = await sharp(imagePath)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return {
    data,
    width: info.width,
    height: info.height,
    channels: info.channels,
  };
}

function getPixel(img, x, y) {
  const idx = (y * img.width + x) * img.channels;
  return {
    r: img.data[idx],
    g: img.data[idx + 1],
    b: img.data[idx + 2],
  };
}

function isColoredPixel({ r, g, b }) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const saturation = max - min;

  // 흰 배경 제외
  if (r > 235 && g > 235 && b > 235) return false;

  // 검정/회색 글자, 격자선 제외
  if (saturation < 35) return false;

  // 너무 어두운 픽셀 제외
  if (max < 80) return false;

  return true;
}

function findSegmentsInColumn(img, col) {
  const rows = [];

  for (let y = CONFIG.scanY1; y <= CONFIG.scanY2; y++) {
    let coloredCount = 0;
    const width = col.x2 - col.x1 + 1;

    for (let x = col.x1; x <= col.x2; x++) {
      if (isColoredPixel(getPixel(img, x, y))) {
        coloredCount++;
      }
    }

    const ratio = coloredCount / width;

    if (ratio >= CONFIG.rowColorRatio) {
      rows.push(y);
    }
  }

  return mergeRowsToSegments(rows)
    .filter(seg => seg.y2 - seg.y1 >= CONFIG.minSegmentHeight)
    .map(seg => ({
      day: col.day,
      x1: col.x1,
      x2: col.x2,
      y1: seg.y1,
      y2: seg.y2,
    }));
}

function mergeRowsToSegments(rows) {
  if (rows.length === 0) return [];

  const segments = [];
  let start = rows[0];
  let prev = rows[0];

  for (let i = 1; i < rows.length; i++) {
    const y = rows[i];

    if (y - prev <= 2) {
      prev = y;
    } else {
      segments.push({ y1: start, y2: prev });
      start = y;
      prev = y;
    }
  }

  segments.push({ y1: start, y2: prev });

  return segments;
}

function yToTime(y) {
  const hourFloat = CONFIG.startHour + (y - CONFIG.yStart) / CONFIG.hourHeight;

  // 30분 단위 반올림
  const rounded = Math.round(hourFloat * 2) / 2;

  const hour = Math.floor(rounded);
  const minute = rounded % 1 === 0.5 ? 30 : 0;

  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

async function cropEvent(inputPath, eventBox, outputPath) {
  const left = Math.max(0, eventBox.x1 + CONFIG.cropPaddingX);
  const top = Math.max(0, eventBox.y1 + CONFIG.cropPaddingY);
  const width = Math.max(
    1,
    eventBox.x2 - eventBox.x1 + 1 - CONFIG.cropPaddingX * 2
  );
  const height = Math.max(
    1,
    eventBox.y2 - eventBox.y1 + 1 - CONFIG.cropPaddingY * 2
  );

  await sharp(inputPath)
    .extract({ left, top, width, height })
    .resize({
      width: width * 3,
      height: height * 3,
      fit: "fill",
    })
    .png()
    .toFile(outputPath);
}

function cleanText(text) {
  return text
    .replace(/\r/g, "")
    .replace(/[|]/g, "")
    .split("\n")
    .map(v => v.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function parseText(text) {
  const lines = text
    .split("\n")
    .map(v => v.trim())
    .filter(Boolean);

  let room = null;
  const titleLines = [];

  for (const line of lines) {
    // 예: 5남532, 5동102 같은 강의실 패턴
    if (!room && /\d+[가-힣]\d+/.test(line)) {
      room = line;
    } else {
      titleLines.push(line);
    }
  }

  return {
    title: titleLines.join(" ") || null,
    room,
    raw: text || null,
  };
}

function buildByDay(events) {
  const result = {};

  for (const event of events) {
    if (!result[event.day]) result[event.day] = [];

    result[event.day].push({
      start: event.start,
      end: event.end,
      title: event.title,
      room: event.room,
      raw: event.raw,
    });
  }

  return result;
}

async function main() {
  console.log("이미지:", inputPath);

  const img = await loadRgb(inputPath);

  const boxes = [];

  for (const col of CONFIG.columns) {
    const segments = findSegmentsInColumn(img, col);
    boxes.push(...segments);
  }

  boxes.sort((a, b) => {
    const dayOrder = ["월", "화", "수", "목", "금"];
    return dayOrder.indexOf(a.day) - dayOrder.indexOf(b.day) || a.y1 - b.y1;
  });

  console.log("감지된 블록:");
  for (const box of boxes) {
    console.log(
      `${box.day} x=${box.x1}-${box.x2}, y=${box.y1}-${box.y2}, ${yToTime(box.y1)}-${yToTime(box.y2)}`
    );
  }

  const worker = await createWorker("kor+eng");

  await worker.setParameters({
    tessedit_pageseg_mode: "6",
    preserve_interword_spaces: "1",
  });

  const events = [];

  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];

    const cropPath = path.join(
      TMP_DIR,
      `event_${String(i).padStart(2, "0")}_${box.day}_${yToTime(box.y1).replace(":", "")}.png`
    );

    await cropEvent(inputPath, box, cropPath);

    const { data } = await worker.recognize(cropPath);
    const text = cleanText(data.text);
    const parsed = parseText(text);

    events.push({
      day: box.day,
      start: yToTime(box.y1),
      end: yToTime(box.y2),
      title: parsed.title,
      room: parsed.room,
      raw: parsed.raw,
      box: {
        x1: box.x1,
        y1: box.y1,
        x2: box.x2,
        y2: box.y2,
      },
    });

    console.log(`[OCR] ${box.day} ${yToTime(box.y1)}-${yToTime(box.y2)}:`, JSON.stringify(text));
  }

  await worker.terminate();

  const output = {
    events,
    byDay: buildByDay(events),
  };

  fs.writeFileSync(
    path.join(__dirname, "..", "result.json"),
    JSON.stringify(output, null, 2),
    "utf-8"
  );

  console.log("\n===== JSON 결과 =====");
  console.log(JSON.stringify(output, null, 2));
  console.log("\n저장됨: result.json");
  console.log("crop 확인 폴더: tmp/");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});