const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { createWorker } = require("tesseract.js");

const inputPath = process.argv[2];

if (!inputPath) {
  console.error("사용법: node src/extract.js <이미지파일>");
  console.error("예시: node src/extract.js timetable.png");
  process.exit(1);
}

const TMP_DIR = path.join(__dirname, "..", "tmp");
fs.mkdirSync(TMP_DIR, { recursive: true });

/**
 * 이미지에서 회색조 raw buffer를 가져옵니다.
 */
async function loadGrayImage(imagePath) {
  const { data, info } = await sharp(imagePath)
    .grayscale()
    .normalize()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return {
    data,
    width: info.width,
    height: info.height,
  };
}

/**
 * 특정 row가 격자선인지 판단합니다.
 * threshold보다 어두운 픽셀 비율이 minRatio 이상이면 선으로 봅니다.
 */
function detectHorizontalLines(gray, options = {}) {
  const {
    darkThreshold = 90,
    minRatio = 0.45,
    minLineGap = 4,
  } = options;

  const lines = [];

  for (let y = 0; y < gray.height; y++) {
    let darkCount = 0;

    for (let x = 0; x < gray.width; x++) {
      const value = gray.data[y * gray.width + x];
      if (value < darkThreshold) darkCount++;
    }

    const ratio = darkCount / gray.width;

    if (ratio >= minRatio) {
      lines.push(y);
    }
  }

  return mergeNearbyPositions(lines, minLineGap);
}

/**
 * 특정 column이 격자선인지 판단합니다.
 */
function detectVerticalLines(gray, options = {}) {
  const {
    darkThreshold = 90,
    minRatio = 0.45,
    minLineGap = 4,
  } = options;

  const lines = [];

  for (let x = 0; x < gray.width; x++) {
    let darkCount = 0;

    for (let y = 0; y < gray.height; y++) {
      const value = gray.data[y * gray.width + x];
      if (value < darkThreshold) darkCount++;
    }

    const ratio = darkCount / gray.height;

    if (ratio >= minRatio) {
      lines.push(x);
    }
  }

  return mergeNearbyPositions(lines, minLineGap);
}

/**
 * 가까운 선 픽셀들을 하나의 선 위치로 합칩니다.
 * 예: [10, 11, 12, 50, 51] -> [11, 50]
 */
function mergeNearbyPositions(positions, maxGap) {
  if (positions.length === 0) return [];

  const groups = [];
  let current = [positions[0]];

  for (let i = 1; i < positions.length; i++) {
    const prev = positions[i - 1];
    const curr = positions[i];

    if (curr - prev <= maxGap) {
      current.push(curr);
    } else {
      groups.push(current);
      current = [curr];
    }
  }

  groups.push(current);

  return groups.map(group => {
    const sum = group.reduce((a, b) => a + b, 0);
    return Math.round(sum / group.length);
  });
}

/**
 * 선 좌표들 사이를 셀 영역으로 변환합니다.
 */
function buildCellsFromLines(xLines, yLines, options = {}) {
  const {
    minCellWidth = 20,
    minCellHeight = 20,
    padding = 4,
  } = options;

  const cells = [];

  for (let row = 0; row < yLines.length - 1; row++) {
    for (let col = 0; col < xLines.length - 1; col++) {
      const left = xLines[col] + padding;
      const top = yLines[row] + padding;
      const right = xLines[col + 1] - padding;
      const bottom = yLines[row + 1] - padding;

      const width = right - left;
      const height = bottom - top;

      if (width >= minCellWidth && height >= minCellHeight) {
        cells.push({
          row,
          col,
          left,
          top,
          width,
          height,
        });
      }
    }
  }

  return cells;
}

/**
 * 각 셀을 crop해서 임시 이미지로 저장합니다.
 */
async function cropCell(imagePath, cell, outputPath) {
  await sharp(imagePath)
    .extract({
      left: cell.left,
      top: cell.top,
      width: cell.width,
      height: cell.height,
    })
    .grayscale()
    .normalize()
    .resize({
      width: cell.width * 2,
      height: cell.height * 2,
      fit: "fill",
    })
    .png()
    .toFile(outputPath);
}

/**
 * OCR 텍스트 정리
 */
function cleanText(text) {
  return text
    .replace(/\r/g, "")
    .replace(/[|]/g, "")
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

/**
 * 셀 배열을 JSON 표 형태로 변환합니다.
 *
 * 첫 번째 행은 요일 헤더,
 * 첫 번째 열은 교시 헤더라고 가정합니다.
 */
function cellsToTimetableJson(ocrCells) {
  const result = {};
  const maxRow = Math.max(...ocrCells.map(c => c.row));
  const maxCol = Math.max(...ocrCells.map(c => c.col));

  const getCellText = (row, col) => {
    const cell = ocrCells.find(c => c.row === row && c.col === col);
    return cell ? cell.text : "";
  };

  for (let col = 1; col <= maxCol; col++) {
    const dayName = getCellText(0, col) || `col_${col}`;
    result[dayName] = {};

    for (let row = 1; row <= maxRow; row++) {
      const periodName = getCellText(row, 0) || `row_${row}`;
      const value = getCellText(row, col);

      result[dayName][periodName] = value || null;
    }
  }

  return result;
}

async function main() {
  console.log("이미지 분석 중:", inputPath);

  const gray = await loadGrayImage(inputPath);

  console.log(`이미지 크기: ${gray.width} x ${gray.height}`);

  const yLines = detectHorizontalLines(gray, {
    darkThreshold: 100,
    minRatio: 0.35,
    minLineGap: 5,
  });

  const xLines = detectVerticalLines(gray, {
    darkThreshold: 100,
    minRatio: 0.35,
    minLineGap: 5,
  });

  console.log("가로선:", yLines);
  console.log("세로선:", xLines);

  if (xLines.length < 2 || yLines.length < 2) {
    console.error("격자선을 충분히 찾지 못했습니다.");
    console.error("이미지의 선이 흐리거나, 배경/글자 대비가 약할 수 있습니다.");
    console.error("darkThreshold, minRatio 값을 조정해보세요.");
    process.exit(1);
  }

  const cells = buildCellsFromLines(xLines, yLines, {
    minCellWidth: 20,
    minCellHeight: 20,
    padding: 4,
  });

  console.log(`감지된 셀 수: ${cells.length}`);

  const worker = await createWorker("kor+eng");

  const ocrCells = [];

  for (const cell of cells) {
    const cellPath = path.join(TMP_DIR, `cell_r${cell.row}_c${cell.col}.png`);

    await cropCell(inputPath, cell, cellPath);

    const { data } = await worker.recognize(cellPath);
    const text = cleanText(data.text);

    ocrCells.push({
      row: cell.row,
      col: cell.col,
      text,
    });

    console.log(`[row=${cell.row}, col=${cell.col}]`, JSON.stringify(text));
  }

  await worker.terminate();

  const timetableJson = cellsToTimetableJson(ocrCells);

  const outputPath = path.join(__dirname, "..", "result.json");
  fs.writeFileSync(outputPath, JSON.stringify(timetableJson, null, 2), "utf-8");

  console.log("\n===== JSON 결과 =====");
  console.log(JSON.stringify(timetableJson, null, 2));
  console.log(`\n저장 완료: ${outputPath}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});