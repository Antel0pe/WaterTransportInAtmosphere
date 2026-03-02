import { FolderApi } from "tweakpane";

type ButtonValue = string | number;

function setButtonSelectedStyle(el: HTMLButtonElement, selected: boolean) {
  el.setAttribute("aria-pressed", selected ? "true" : "false");
  el.dataset.selected = selected ? "true" : "false";

  if (selected) {
    el.style.background = "rgba(80, 170, 255, 0.38)";
    el.style.border = "1px solid rgba(140, 210, 255, 0.95)";
    el.style.boxShadow = "inset 0 0 0 1px rgba(255, 255, 255, 0.28)";
    el.style.fontWeight = "600";
    el.style.opacity = "1";
    return;
  }

  el.style.background = "";
  el.style.border = "";
  el.style.boxShadow = "";
  el.style.fontWeight = "";
  el.style.opacity = "";
}

export function addButtonRowToFolder(
  folder: FolderApi,
  opts: {
    label: string;
    subtextLines?: string[];
    buttons: Array<{
      title: string;
      value: ButtonValue;
      onClick: (value: ButtonValue) => void;
    }>;
    selectedValue?: ButtonValue;
    toggleOffValue?: ButtonValue;
    gapPx?: number;
  }
) {
  const {
    label,
    subtextLines,
    buttons,
    selectedValue,
    toggleOffValue,
    gapPx = 6,
  } = opts;

  const folderRoot = folder.element as HTMLElement;
  const content = folderRoot.querySelector(".tp-fldv_c") as HTMLElement | null;
  if (!content) throw new Error("Could not find .tp-fldv_c for folder");

  // normal row structure: label column + value column
  const row = document.createElement("div");
  row.className = "tp-lblv";

  const left = document.createElement("div");
  left.className = "tp-lblv_l";
  if (subtextLines?.length) {
    left.style.whiteSpace = "normal";
    left.style.display = "flex";
    left.style.flexDirection = "column";
    left.style.alignItems = "flex-start";

    const labelEl = document.createElement("div");
    labelEl.textContent = label;
    left.appendChild(labelEl);

    const subtextEl = document.createElement("div");
    subtextEl.style.fontSize = "11px";
    subtextEl.style.lineHeight = "1.25";
    subtextEl.style.opacity = "0.72";
    subtextEl.style.marginTop = "3px";
    for (const line of subtextLines) {
      const lineEl = document.createElement("div");
      lineEl.textContent = line;
      subtextEl.appendChild(lineEl);
    }
    left.appendChild(subtextEl);
  } else {
    left.textContent = label;
  }

  const right = document.createElement("div");
  right.className = "tp-lblv_v";

  // use tp-btnv wrapper so it aligns like native buttons
  const btnWrap = document.createElement("div");
  btnWrap.className = "tp-btnv";
  btnWrap.style.display = "flex";
  btnWrap.style.alignItems = "center";
  btnWrap.style.gap = `${gapPx}px`;
  btnWrap.style.flexWrap = "wrap";

  const buttonByValue = new Map<ButtonValue, HTMLButtonElement>();
  let currentSelectedValue: ButtonValue | undefined = selectedValue;

  const setSelectedValue = (value: ButtonValue | undefined) => {
    currentSelectedValue = value;
    for (const [buttonValue, el] of buttonByValue.entries()) {
      setButtonSelectedStyle(el, buttonValue === value);
    }
  };

  for (const b of buttons) {
    const el = document.createElement("button");
    el.className = "tp-btnv_b";
    el.style.flex = "0 0 auto";
    el.style.width = "auto";
    el.style.padding = "0 8px";
    el.addEventListener("click", () => {
      const isAlreadySelected = currentSelectedValue === b.value;
      const nextValue =
        toggleOffValue !== undefined && isAlreadySelected
          ? toggleOffValue
          : b.value;
      setSelectedValue(nextValue);
      b.onClick(nextValue);
    });

    const t = document.createElement("div");
    t.className = "tp-btnv_t";
    t.textContent = b.title;

    el.appendChild(t);
    btnWrap.appendChild(el);
    buttonByValue.set(b.value, el);
  }

  right.appendChild(btnWrap);
  row.appendChild(left);
  row.appendChild(right);

  content.appendChild(row);

  if (selectedValue !== undefined) {
    setSelectedValue(selectedValue);
  }

  return { row, btnWrap, setSelectedValue };
}

export function addSeparatorToFolder(folder: FolderApi) {
  const content = (folder.element as HTMLElement).querySelector(".tp-fldv_c") as HTMLElement | null;
  if (!content) throw new Error("Could not find .tp-fldv_c for folder");

  const row = document.createElement("div");
  row.className = "tp-lblv";

  const left = document.createElement("div");
  left.className = "tp-lblv_l";

  const right = document.createElement("div");
  right.className = "tp-lblv_v";

  const hr = document.createElement("div");
  hr.style.height = "1px";
  hr.style.width = "100%";
  hr.style.background = "currentColor";
  hr.style.opacity = "0.25";
  hr.style.margin = "6px 0";

  right.appendChild(hr);
  row.append(left, right);
  content.appendChild(row);
}
