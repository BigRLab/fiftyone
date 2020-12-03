import { selector, selectorFamily } from "recoil";
import ReconnectingWebSocket from "reconnecting-websocket";
import uuid from "uuid-v4";

import * as atoms from "./atoms";
import { generateColorMap } from "../utils/colors";
import { isElectron } from "../utils/generic";
import {
  RESERVED_FIELDS,
  VALID_LABEL_TYPES,
  VALID_LIST_TYPES,
  VALID_NUMERIC_TYPES,
  VALID_SCALAR_TYPES,
  makeLabelNameGroups,
  labelTypeHasColor,
} from "../utils/labels";
import { packageMessage } from "../utils/socket";

class HTTPSSocket {
  location: string;
  events: {
    [name: string]: Set<(data: object) => void>;
  } = {};
  readyState: number = WebSocket.CONNECTING;
  openTimeout: number = 2000;
  timeout: number = 2000;
  interval: number;

  constructor(location: string) {
    this.location = location;
    this.connect();
  }

  connect() {
    this.gather();
    this.interval = setInterval(() => this.gather(), this.timeout);
  }

  execute(messages) {
    if ([WebSocket.CLOSED, WebSocket.CONNECTING].includes(this.readyState)) {
      this.events.open.forEach((h) => h(null));
      this.timeout = this.openTimeout;
      clearInterval(this.interval);
      this.interval = setInterval(() => this.gather(), this.timeout);
    }
    this.readyState = WebSocket.OPEN;
    messages.forEach((m) => {
      fetch(this.location + "&mode=pull", {
        method: "post",
        body: JSON.stringify(m),
      })
        .then((response) => response.json())
        .then((data) => {
          this.events.message.forEach((h) => h({ data: JSON.stringify(data) }));
        });
    });
  }

  gather() {
    fetch(this.location)
      .then((response) => response.json())
      .then(({ messages }) => this.execute(messages))
      .catch(() => {
        if (this.readyState === WebSocket.OPEN && this.events.close) {
          this.events.close.forEach((h) => h(null));
        }
        this.readyState = WebSocket.CLOSED;
        clearInterval(this.interval);
        this.timeout = Math.min(this.timeout * 2, 5000);
        this.interval = setInterval(() => this.gather(), this.timeout);
      });
  }

  addEventListener(eventType, handler) {
    if (!this.events[eventType]) {
      this.events[eventType] = new Set();
    }
    this.events[eventType].add(handler);
  }

  removeEventListener(eventType, handler) {
    this.events[eventType].delete(handler);
  }

  send(message) {
    fetch(this.location + "&mode=push", {
      method: "post",
      body: message,
    })
      .then((response) => response.json())
      .then((data) => {
        const { messages, type } = data;
        messages && this.execute(messages);
        type &&
          this.events.message.forEach((h) => h({ data: JSON.stringify(data) }));
      });
  }
}

export const sessionId = uuid();

const host =
  import.meta.env.MODE === "development"
    ? "localhost:5151"
    : window.location.host;

export const http = selector({
  key: "http",
  get: ({ get }) => {
    if (isElectron()) {
      return `http://localhost:${get(atoms.port)}`;
    } else {
      const loc = window.location;
      return loc.protocol + "//" + host;
    }
  },
});

export const ws = selector({
  key: "ws",
  get: () => {
    let url = null;
    const loc = window.location;
    if (loc.protocol === "https:") {
      url = "wss:";
    } else {
      url = "ws:";
    }
    return url + "//" + host + "/state";
  },
});

export const fiftyone = selector({
  key: "fiftyone",
  get: async ({ get }) => {
    let response = null;
    do {
      try {
        response = await fetch(`${get(http)}/fiftyone`);
      } catch {}
      if (response) break;
      await new Promise((r) => setTimeout(r, 2000));
    } while (response === null);
    const data = await response.json();
    return data;
  },
});

export const isColab = selector({
  key: "isColab",
  get: () => {
    const search = window.location.search;
    const params = new URLSearchParams(search);
    return params.get("fiftyoneColab");
  },
});

export const socket = selector({
  key: "socket",
  get: ({ get }): ReconnectingWebSocket | HTTPSSocket => {
    if (get(isColab)) {
      return new HTTPSSocket(`${get(http)}/polling?sessionId=${sessionId}`);
    } else {
      return new ReconnectingWebSocket(get(ws));
    }
  },
  dangerouslyAllowMutability: true,
});

export const datasetName = selector({
  key: "datasetName",
  get: ({ get }) => {
    const stateDescription = get(atoms.stateDescription);
    return stateDescription.dataset ? stateDescription.dataset.name : null;
  },
});

export const datasets = selector({
  key: "datasets",
  get: ({ get }) => {
    return get(atoms.stateDescription).datasets ?? [];
  },
});

export const hasDataset = selector({
  key: "hasDataset",
  get: ({ get }) => Boolean(get(datasetName)),
});

export const mediaType = selector({
  key: "mediaType",
  get: ({ get }) => {
    const stateDescription = get(atoms.stateDescription);
    return stateDescription.dataset
      ? stateDescription.dataset.media_type
      : null;
  },
});

export const view = selector({
  key: "view",
  get: ({ get }) => {
    return get(atoms.stateDescription).view || [];
  },
  set: ({ get, set }, stages) => {
    const state = get(atoms.stateDescription);
    const newState = {
      ...state,
      view: stages,
    };
    set(atoms.datasetStatsLoading, true);
    if (Object.keys(state.filters).length) {
      set(atoms.extendedDatasetStatsLoading, true);
    }
    set(atoms.stateDescription, newState);
    get(socket).send(packageMessage("update", { state: newState }));
  },
});

export const filterStages = selector({
  key: "filterStages",
  get: ({ get }) => {
    return get(atoms.stateDescription).filters;
  },
  set: ({ get, set }, filters) => {
    const state = {
      ...get(atoms.stateDescription),
      filters,
    };
    const sock = get(socket);
    sock.send(packageMessage("filters_update", { filters }));
    set(atoms.extendedDatasetStatsLoading, true);
    set(atoms.stateDescription, state);
  },
});

export const filterStage = selectorFamily({
  key: "filterStage",
  get: (path) => ({ get }) => {
    return get(filterStages)?.[path] ?? {};
  },
  set: (path: string) => ({ get, set }, value) => {
    const filters = Object.assign({}, get(filterStages));
    if (!value && !filters[path]) return;
    if (JSON.stringify(value) === JSON.stringify(filters[path])) return;
    if (!value && path in filters) {
      delete filters[path];
    } else {
      filters[path] = value;
    }
    set(filterStages, filters);
  },
});

export const paginatedFilterStages = selector({
  key: "paginatedFilterStages",
  get: ({ get }) => {
    const scalars = get(scalarNames("sample"));
    const filters = get(filterStages);
    return Object.keys(filters).reduce((acc, cur) => {
      if (scalars.includes(cur)) {
        acc[cur] = filters[cur];
      }
      return acc;
    }, {});
  },
});

export const extendedView = selector({
  key: "extendedView",
  get: ({ get }) => {
    const viewValue = get(view);
    const stages = [];
    for (const filter in get(filterStages)) {
      stages.push(filter);
    }
    return [...viewValue, ...stages];
  },
});

export const totalCount = selector({
  key: "totalCount",
  get: ({ get }): number => {
    const stats = get(atoms.datasetStats) || [];
    return stats.reduce(
      (acc, cur) => (cur.name === "count" ? cur.count : acc),
      null
    );
  },
});

export const filteredCount = selector({
  key: "filteredCount",
  get: ({ get }): number => {
    const stats = get(atoms.extendedDatasetStats) || [];
    return stats.reduce(
      (acc, cur) => (cur.name === "count" ? cur.count : acc),
      null
    );
  },
});

export const tagNames = selector({
  key: "tagNames",
  get: ({ get }) => {
    return get(atoms.datasetStats).reduce((acc, cur) => {
      if (cur.name === "tags") {
        return Object.keys(cur.values).sort();
      }
      return acc;
    }, []);
  },
});

export const tagSampleCounts = selector({
  key: "tagSampleCounts",
  get: ({ get }) => {
    return get(atoms.datasetStats).reduce((acc, cur) => {
      if (cur.name === "tags") {
        return cur.values;
      }
      return acc;
    }, {});
  },
});

export const filteredTagSampleCounts = selector({
  key: "filteredTagSampleCounts",
  get: ({ get }) => {
    return get(atoms.extendedDatasetStats).reduce((acc, cur) => {
      if (cur.name === "tags") {
        return cur.values;
      }
      return acc;
    }, {});
  },
});

export const fieldSchema = selectorFamily({
  key: "fieldSchema",
  get: (dimension: string) => ({ get }) => {
    const d = get(atoms.stateDescription).dataset || {};
    return d[dimension + "_fields"] || [];
  },
});

const labelFilter = (f) => {
  return (
    f.embedded_doc_type &&
    VALID_LABEL_TYPES.includes(f.embedded_doc_type.split(".").slice(-1)[0])
  );
};

const scalarFilter = (f) => {
  return VALID_SCALAR_TYPES.includes(f.ftype);
};

const fields = selectorFamily({
  key: "fields",
  get: (dimension: string) => ({ get }) => {
    return get(fieldSchema(dimension)).reduce((acc, cur) => {
      acc[cur.name] = cur;
      return acc;
    }, {});
  },
});

export const fieldPaths = selector({
  key: "fieldPaths",
  get: ({ get }) => {
    const excludePrivateFilter = (f) => !f.startsWith("_");
    const fieldsNames = Object.keys(get(fields("sample"))).filter(
      excludePrivateFilter
    );
    if (get(mediaType) === "video") {
      return fieldsNames
        .concat(
          Object.keys(get(fields("frame")))
            .filter(excludePrivateFilter)
            .map((f) => "frames." + f)
        )
        .sort();
    }
    return fieldsNames.sort();
  },
});

const labels = selectorFamily({
  key: "labels",
  get: (dimension: string) => ({ get }) => {
    const fieldsValue = get(fields(dimension));
    return Object.keys(fieldsValue)
      .map((k) => fieldsValue[k])
      .filter(labelFilter);
  },
});

export const labelNames = selectorFamily({
  key: "labelNames",
  get: (dimension: string) => ({ get }) => {
    const l = get(labels(dimension));
    return l.map((l) => l.name);
  },
});

export const labelPaths = selector({
  key: "labelPaths",
  get: ({ get }) => {
    const sampleLabels = get(labelNames("sample"));
    const frameLabels = get(labelNames("frame"));
    return sampleLabels.concat(frameLabels.map((l) => "frames." + l));
  },
});

export const labelTypes = selectorFamily({
  key: "labelTypes",
  get: (dimension: string) => ({ get }) => {
    return get(labels(dimension)).map((l) => {
      return l.embedded_doc_type.split(".").slice(-1)[0];
    });
  },
});

const scalars = selectorFamily({
  key: "scalars",
  get: (dimension: string) => ({ get }) => {
    const fieldsValue = get(fields(dimension));
    return Object.keys(fieldsValue)
      .map((k) => fieldsValue[k])
      .filter(scalarFilter);
  },
});

export const scalarNames = selectorFamily({
  key: "scalarNames",
  get: (dimension: string) => ({ get }) => {
    const l = get(scalars(dimension));
    return l.map((l) => l.name);
  },
});

export const scalarTypes = selectorFamily({
  key: "scalarTypes",
  get: (dimension: string) => ({ get }) => {
    const l = get(scalars(dimension));
    return l.map((l) => l.ftype);
  },
});

const COUNT_CLS = "fiftyone.core.aggregations.CountResult";
const LABELS_CLS = "fiftyone.core.aggregations.DistinctLabelsResult";
const BOUNDS_CLS = "fiftyone.core.aggregations.BoundsResult";
const CONFIDENCE_BOUNDS_CLS =
  "fiftyone.core.aggregations.ConfidenceBoundsResult";

export const labelClasses = selectorFamily({
  key: "labelClasses",
  get: (label) => ({ get }) => {
    return get(atoms.datasetStats).reduce((acc, cur) => {
      if (cur.name === label && cur._CLS === LABELS_CLS) {
        return cur.labels;
      }
      return acc;
    }, []);
  },
});

export const labelSampleCounts = selectorFamily({
  key: "labelSampleCounts",
  get: (dimension: string) => ({ get }) => {
    const names = get(labelNames(dimension)).concat(
      get(scalarNames(dimension))
    );
    const prefix = dimension === "sample" ? "" : "frames.";
    return get(atoms.datasetStats).reduce((acc, cur) => {
      if (
        names.includes(cur.name.slice(prefix.length)) &&
        cur._CLS === COUNT_CLS
      ) {
        acc[cur.name.slice(prefix.length)] = cur.count;
      }
      return acc;
    }, {});
  },
});

export const filteredLabelSampleCounts = selectorFamily({
  key: "filteredLabelSampleCounts",
  get: (dimension: string) => ({ get }) => {
    const names = get(labelNames(dimension)).concat(
      get(scalarNames(dimension))
    );
    const prefix = dimension === "sample" ? "" : "frames.";
    return get(atoms.extendedDatasetStats).reduce((acc, cur) => {
      if (
        names.includes(cur.name.slice(prefix.length)) &&
        cur._CLS === COUNT_CLS
      ) {
        acc[cur.name.slice(prefix.length)] = cur.count;
      }
      return acc;
    }, {});
  },
});

export const labelFilters = selector({
  key: "labelFilters",
  get: ({ get }) => {
    const frameLabels = get(atoms.activeLabels("frame"));
    const labels = {
      ...get(atoms.activeLabels("sample")),
      ...Object.keys(frameLabels).reduce((acc, cur) => {
        return {
          ...acc,
          ["frames." + cur]: frameLabels[cur],
        };
      }, {}),
    };
    const filters = {};
    for (const label in labels) {
      const range = get(filterLabelConfidenceRange(label));
      const none = get(filterLabelIncludeNoConfidence(label));
      const include = get(filterIncludeLabels(label));
      filters[label] = (s) => {
        const inRange =
          range[0] - 0.005 <= s.confidence && s.confidence <= range[1] + 0.005;
        const noConfidence = none && s.confidence === undefined;
        const isIncluded = include.length === 0 || include.includes(s.label);
        return (inRange || noConfidence) && isIncluded;
      };
    }
    return filters;
  },
});

export const modalLabelFilters = selector({
  key: "modalLabelFilters",
  get: ({ get }) => {
    const frameLabels = get(atoms.modalActiveLabels("frame"));
    const labels = {
      ...get(atoms.modalActiveLabels("sample")),
      ...Object.keys(frameLabels).reduce((acc, cur) => {
        return {
          ...acc,
          ["frames." + cur]: frameLabels[cur],
        };
      }, {}),
    };
    const hiddenObjects = get(atoms.hiddenObjects);
    const filters = {};
    for (const label in labels) {
      const range = get(atoms.modalFilterLabelConfidenceRange(label));
      const none = get(atoms.modalFilterLabelIncludeNoConfidence(label));
      const include = get(atoms.modalFilterIncludeLabels(label));
      filters[label] = (s) => {
        if (hiddenObjects[s.id]) {
          return false;
        }
        const inRange =
          range[0] - 0.005 <= s.confidence && s.confidence <= range[1] + 0.005;
        const noConfidence = none && s.confidence === undefined;
        const isIncluded = include.length === 0 || include.includes(s.label);
        return labels[label] && (inRange || noConfidence) && isIncluded;
      };
    }
    return filters;
  },
  set: ({ get, set }, _) => {
    const paths = get(labelPaths);
    const activeLabels = get(atoms.activeLabels("sample"));
    set(atoms.modalActiveLabels("sample"), activeLabels);
    const activeFrameLabels = get(atoms.activeLabels("frame"));
    set(atoms.modalActiveLabels("frame"), activeFrameLabels);
    for (const label of paths) {
      set(
        atoms.modalFilterLabelConfidenceRange(label),
        get(filterLabelConfidenceRange(label))
      );

      set(
        atoms.modalFilterLabelIncludeNoConfidence(label),
        get(filterLabelIncludeNoConfidence(label))
      );

      set(
        atoms.modalFilterIncludeLabels(label),
        get(filterIncludeLabels(label))
      );

      set(atoms.modalColorByLabel, get(atoms.colorByLabel));
    }
  },
});

export const labelTuples = selectorFamily({
  key: "labelTuples",
  get: (dimension: string) => ({ get }) => {
    const types = get(labelTypes(dimension));
    return get(labelNames(dimension)).map((n, i) => [n, types[i]]);
  },
});

const scalarsMap = selectorFamily({
  key: "scalarsMap",
  get: (dimension: string) => ({ get }) => {
    const types = get(scalarTypes(dimension));
    return get(scalarNames(dimension)).reduce(
      (acc, cur, i) => ({
        ...acc,
        [cur]: types[i],
      }),
      {}
    );
  },
});

export const refreshColorMap = selector({
  key: "refreshColorMap",
  get: ({ get }) => get(atoms.colorMap),
  set: ({ get, set }, colorMap) => {
    const colorLabelNames = get(labelTuples("sample"))
      .filter(([name, type]) => labelTypeHasColor(type))
      .map(([name]) => name);
    const colorFrameLabelNames = get(labelTuples("frame"))
      .filter(([name, type]) => labelTypeHasColor(type))
      .map(([name]) => "frames." + name);
    const scalarsList = [
      ...get(scalarNames("sample")),
      ...get(scalarNames("frame")),
    ];
    set(
      atoms.colorMap,
      generateColorMap(
        [
          ...get(tagNames),
          ...scalarsList,
          ...colorLabelNames,
          ...colorFrameLabelNames,
        ],
        colorMap
      )
    );
  },
});

export const isLabel = selectorFamily({
  key: "isLabel",
  get: (field) => ({ get }) => {
    const names = get(labelNames("sample")).concat(
      get(labelNames("frame")).map((l) => "frames." + l)
    );
    return names.includes(field);
  },
});

export const modalFieldIsFiltered = selectorFamily({
  key: "modalFieldIsFiltered",
  get: (field: string) => ({ get }): boolean => {
    const label = get(isLabel(field));

    if (!label) {
      return false;
    }

    const range = get(atoms.modalFilterLabelConfidenceRange(field));
    const bounds = get(labelConfidenceBounds(field));
    const none = get(atoms.modalFilterLabelIncludeNoConfidence(field));
    const include = get(atoms.modalFilterIncludeLabels(field));
    const maxMin = label ? 0 : bounds[0];
    const minMax = label ? 1 : bounds[1];
    const stretchedBounds = [
      maxMin < bounds[0] && bounds[1] !== bounds[0] ? maxMin : bounds[0],
      minMax > bounds[1] && bounds[1] !== bounds[0] ? minMax : bounds[1],
    ];

    const rangeIsFiltered =
      stretchedBounds.some(
        (b, i) => range[i] !== b && b !== null && range[i] !== null
      ) && bounds[0] !== bounds[1];

    return Boolean(include.length) || rangeIsFiltered || !none;
  },
});

export const fieldIsFiltered = selectorFamily({
  key: "fieldIsFiltered",
  get: (field: string) => ({ get }): boolean => {
    const label = get(isLabel(field));
    const numeric = get(isNumericField(field));
    const range = get(
      label ? filterLabelConfidenceRange(field) : filterNumericFieldRange(field)
    );
    const bounds = get(
      label ? labelConfidenceBounds(field) : numericFieldBounds(field)
    );
    const none = get(
      label
        ? filterLabelIncludeNoConfidence(field)
        : filterNumericFieldIncludeNone(field)
    );
    const include = get(filterIncludeLabels(field));
    const maxMin = label ? 0 : bounds[0];
    const minMax = label ? 1 : bounds[1];
    const stretchedBounds = [
      maxMin < bounds[0] ? maxMin : bounds[0],
      minMax > bounds[1] ? minMax : bounds[1],
    ];

    if (!label && !numeric) return false;

    const rangeIsFiltered =
      stretchedBounds.some(
        (b, i) => range[i] !== b && b !== null && range[i] !== null
      ) && bounds[0] !== bounds[1];

    if (numeric) return rangeIsFiltered || !none;

    return Boolean(include.length) || rangeIsFiltered || !none;
  },
});

export const labelConfidenceBounds = selectorFamily({
  key: "labelConfidenceBounds",
  get: (label) => ({ get }) => {
    return get(atoms.datasetStats).reduce(
      (acc, cur) => {
        if (cur.name === label && cur._CLS === CONFIDENCE_BOUNDS_CLS) {
          let bounds = cur.bounds;
          bounds = [
            0 < bounds[0] ? 0 : bounds[0],
            1 > bounds[1] ? 1 : bounds[1],
          ];
          return [
            bounds[0] !== null && bounds[0] !== 0
              ? Number((bounds[0] - 0.01).toFixed(2))
              : bounds[0],
            bounds[1] !== null && bounds[1] !== 1
              ? Number((bounds[1] + 0.01).toFixed(2))
              : bounds[1],
          ];
        }
        return acc;
      },
      [null, null]
    );
  },
});

export const numericFieldBounds = selectorFamily({
  key: "numericFieldBounds",
  get: (label) => ({ get }) => {
    return get(atoms.datasetStats).reduce(
      (acc, cur) => {
        if (cur.name === label && cur._CLS === BOUNDS_CLS) {
          const { bounds } = cur;
          return [
            bounds[0] !== null && bounds[0] !== 0
              ? Number((bounds[0] - 0.01).toFixed(2))
              : bounds[0],
            bounds[1] !== null && bounds[1] !== 1
              ? Number((bounds[1] + 0.01).toFixed(2))
              : bounds[1],
          ];
        }
        return acc;
      },
      [null, null]
    );
  },
});

export const labelNameGroups = selectorFamily({
  key: "labelNameGroups",
  get: (dimension: string) => ({ get }) =>
    makeLabelNameGroups(
      get(fields(dimension)),
      get(labelNames(dimension)),
      get(labelTypes(dimension))
    ),
});

export const isNumericField = selectorFamily({
  key: "isNumericField",
  get: (name) => ({ get }) => {
    const map = get(scalarsMap("sample"));
    return VALID_NUMERIC_TYPES.includes(map[name]);
  },
});

export const sampleModalFilter = selector({
  key: "sampleModalFilter",
  get: ({ get }) => {
    const filters = get(modalLabelFilters);
    const frameLabels = get(atoms.modalActiveLabels("frame"));
    const activeLabels = {
      ...get(atoms.modalActiveLabels("sample")),
      ...Object.keys(frameLabels).reduce((acc, cur) => {
        return {
          ...acc,
          ["frames." + cur]: frameLabels[cur],
        };
      }, {}),
    };
    return (sample) => {
      return Object.entries(sample).reduce((acc, [key, value]) => {
        if (key === "tags") {
          acc[key] = value;
        } else if (value && VALID_LIST_TYPES.includes(value._cls)) {
          acc[key] =
            filters[key] && value !== null
              ? {
                  ...value,
                  [value._cls.toLowerCase()]: value[
                    value._cls.toLowerCase()
                  ].filter(filters[key]),
                }
              : value;
        } else if (value !== null && filters[key] && filters[key](value)) {
          acc[key] = value;
        } else if (RESERVED_FIELDS.includes(key)) {
          acc[key] = value;
        } else if (
          ["string", "number", "null"].includes(typeof value) &&
          activeLabels[key]
        ) {
          acc[key] = value;
        }
        return acc;
      }, {});
    };
  },
});

const resolveFilter = (bounds, range, none, labels = null) => {
  const defaultRange = range.every((r, i) => r === bounds[i]);
  if (defaultRange && none && (labels === null || labels.length === 0)) {
    return null;
  }
  const filter = {};
  if (!defaultRange) {
    filter.range = range;
    filter.none = none;
  }
  if (defaultRange && !none) {
    filter.none = none;
  }
  if (labels !== null && labels.length > 0) {
    filter.labels = labels;
  }
  if (Object.keys(filter).length > 0) return filter;
  return null;
};

export const filterIncludeLabels = selectorFamily({
  key: "filterIncludeLabels",
  get: (path) => ({ get }) => {
    const filter = get(filterStage(path));
    return filter?.labels ?? [];
  },
  set: (path) => ({ get, set }, labels) => {
    const bounds = get(labelConfidenceBounds(path));
    const range = get(filterLabelConfidenceRange(path));
    const none = get(filterLabelIncludeNoConfidence(path));
    const filter = resolveFilter(bounds, range, none, labels);
    set(filterStage(path), filter);
  },
});

export const filterLabelConfidenceRange = selectorFamily({
  key: "filterLabelConfidenceRange",
  get: (path) => ({ get }) => {
    const filter = get(filterStage(path));
    if (filter?.range) return filter.range;
    return get(labelConfidenceBounds(path));
  },
  set: (path) => ({ get, set }, range) => {
    const bounds = get(labelConfidenceBounds(path));
    const none = get(filterLabelIncludeNoConfidence(path));
    const labels = get(filterIncludeLabels(path));
    const filter = resolveFilter(bounds, range, none, labels);
    set(filterStage(path), filter);
  },
});

export const filterLabelIncludeNoConfidence = selectorFamily({
  key: "filterLabelIncludeNoConfidence",
  get: (path) => ({ get }) => {
    const filter = get(filterStage(path));
    return filter?.none ?? true;
  },
  set: (path) => ({ get, set }, none) => {
    const range = get(filterLabelConfidenceRange(path));
    const bounds = get(labelConfidenceBounds(path));
    const labels = get(filterIncludeLabels(path));
    const filter = resolveFilter(bounds, range, none, labels);
    set(filterStage(path), filter);
  },
});

export const filterNumericFieldRange = selectorFamily({
  key: "filterNumericFieldRange",
  get: (path) => ({ get }) => {
    const filter = get(filterStage(path));
    return filter?.range ?? get(numericFieldBounds(path));
  },
  set: (path) => ({ get, set }, range) => {
    const bounds = get(numericFieldBounds(path));
    const none = get(filterNumericFieldIncludeNone(path));
    const filter = resolveFilter(bounds, range, none);
    set(filterStage(path), filter);
  },
});

export const filterNumericFieldIncludeNone = selectorFamily({
  key: "filterNumericFieldIncludeNone",
  get: (path) => ({ get }) => {
    const filter = get(filterStage(path));
    return filter?.none ?? true;
  },
  set: (path) => ({ get, set }, none) => {
    const range = get(filterNumericFieldRange(path));
    const bounds = get(numericFieldBounds(path));
    const filter = resolveFilter(bounds, range, none);
    set(filterStage(path), filter);
  },
});