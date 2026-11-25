// The labeled select both harness pages (index.html and lab.html) build their bar's choices from.

/** A choice: its value and the name the select shows. */
export type BarOption = readonly [string, string];

/** Choices the select shows under one heading. */
export interface BarGroup {
  readonly label: string;
  readonly options: readonly BarOption[];
}

function optionOf([value, name]: BarOption): HTMLOptionElement {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = name;
  return option;
}

/** Adds a select labeled `label` to `bar`, offering each choice and group of `options`; `onChange` gets the value chosen. */
export function barSelect(
  bar: HTMLElement,
  label: string,
  options: readonly (BarOption | BarGroup)[],
  onChange: (value: string) => void,
): HTMLSelectElement {
  const wrap = document.createElement('label');
  wrap.textContent = label;
  const select = document.createElement('select');
  for (const entry of options) {
    if ('label' in entry) {
      const group = document.createElement('optgroup');
      group.label = entry.label;
      for (const option of entry.options) group.appendChild(optionOf(option));
      select.appendChild(group);
    } else {
      select.appendChild(optionOf(entry));
    }
  }
  select.addEventListener('change', () => onChange(select.value));
  wrap.appendChild(select);
  bar.appendChild(wrap);
  return select;
}
