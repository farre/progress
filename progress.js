"use strict";
const base = "https://bugzilla.mozilla.org/";

const max_depth = 5;

function encode_query_string(o) {
  return Object.keys(o).map((k) => `${k}=${encodeURIComponent(o[k])}`);
}

function query_string(params) {
  params = params ?? "";
  if (params instanceof Array) {
    params = params.flatMap((value) => {
      if (typeof value !== "object") {
        return value;
      }
      return encode_query_string(value);
    });
  } else if (typeof params === "object") {
    params = encode_query_string(params);
  } else {
    params = [encodeURIComponent(params)];
  }

  return params.join("&");
}

async function rest(endpoint, raw_headers, params) {
  const uri = new URL(`rest/${endpoint}`, base);
  uri.search = query_string(params);
  const headers = new Headers(raw_headers);
  const response = await fetch(uri, { headers });
  return await response.json();
}

async function bugs(id) {
  if (!id.length) {
    return { bugs: []};
  }

  const include_fields = "id,blocks,depends_on,summary,status";
  return await rest(`bug`, {}, [{id, include_fields}]);
}

function unique(nodes, ids) {
  return [...new Set(ids.filter(id => !nodes.hasOwnProperty(id)))];
}

async function create_nodes(start, max_depth) {
  const nodes = {};
  let work_list = [{ depends_on: [start]}];
  let next_work_list = [];
  let depth = 0;
  while (work_list.length) {
    const current_node = work_list.pop();
    const edges = unique(nodes, current_node.depends_on);
    const { bugs: new_nodes } = await bugs(edges);

    for (const node of new_nodes ?? []) {
      nodes[node.id] = node;
    }

    next_work_list.push(...(new_nodes ?? []));

    if (!work_list.length && next_work_list.length) {
      work_list = next_work_list;
      next_work_list = [];
      if (++depth > max_depth) {
        break;
      }
    }
  }

  return nodes;
}

function closed_bug(str) {
  return str.startsWith("RESOLVED") || str.startsWith("VERIFIED")
}

class State {
  static resolved = "resolved";
  static available = "available";
  static blocked = "blocked";
  static unknown = "unknown"

  static get_status(open_bugs, status, leaf) {
    if (!open_bugs && closed_bug(status ?? "")) {
      return State.resolved;
    }

    if (open_bugs && closed_bug(status ?? "")) {
      return State.unknown;
    }

    if (!open_bugs) {
      return State.available;
    }

    if (open_bugs && leaf) {
      return State.unknown;
    }

    return State.blocked;
  }
}

function node_status(nodes, from, to) {
  const from_depends_on = from.depends_on;
  const from_resolved = from_depends_on.filter(
    (node) => closed_bug(nodes[node]?.status ?? "")
  );
  const from_status = `[${from.id} ${from_resolved.length}/${from_depends_on.length}]:::${State.get_status(
    from_depends_on.filter(node => !closed_bug(nodes[node]?.status ?? "")).length,
    from.status
  )}`;

  const to_depends_on = to.depends_on;
  const to_status = !to_depends_on.length ? `[${to.id}${nodes[to.id] ? "" : " ??/??"}]${`:::${State.get_status(nodes[to.id] ? 0 : 1, to.status, true)}`}` : "";

  return { from_status, to_status };
}

function get_node(nodes, id) {
  return nodes[id] ?? {id, depends_on: [], status: ""};
}

function htmlencode(str){
  return str.replaceAll(/["`]/gi, (special, _offset, input) => {
    return `&#${special.charCodeAt(0)};`
  });
}

async function create_graph(start, max_depth) {
  const nodes = await create_nodes(start, max_depth);
  const links = [];
  const interaction = [];
  const styles = [
    "classDef resolved fill:green",
    "classDef available fill:yellow",
    "classDef unknown fill:orange",
    "classDef blocked fill:red",
  ];

  for (const from of Object.values(nodes)) {
    for (const to of from.depends_on) {
      const { to_status, from_status } = node_status(nodes, from, get_node(nodes, to));
      links.push(`${to}${to_status} --> ${from.id}${from_status}`);
    }

    interaction.push(
      `click ${from.id} "https://bugzilla.mozilla.org/show_bug.cgi?id=${from.id}" "${htmlencode(from.summary)}" _blank`
    );

  }
  return `flowchart LR\n${links.join("\n")}\n${interaction.join(
    "\n"
  )}\n${styles.join("\n")}\n`;
}