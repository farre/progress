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
    return { bugs: [] };
  }

  const include_fields =
    "id,blocks,depends_on,summary,status,attachments,assigned_to,resolution,type";
  return await rest(`bug`, {}, [{ id, include_fields }]);
}

function unique(nodes, ids) {
  return [...new Set(ids.filter((id) => !nodes.hasOwnProperty(id)))];
}

async function create_nodes(start, max_depth) {
  const nodes = {};
  let work_list = [{ depends_on: [start] }];
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

function closed_bug(node) {
  const status = node.status ?? "";
  return status.startsWith("RESOLVED") || status.startsWith("VERIFIED");
}

function assigned_bug(node) {
  const status = node.status ?? "";
  const assigned_to = node.assigned_to ?? "";
  return (
    status.startsWith("ASSIGNED") ||
    ((status.startsWith("NEW") || status.startsWith("REOPENED")) &&
      assigned_to !== "nobody@mozilla.org")
  );
}

function duplicate_bug(node) {
  const resolution = node.resolution ?? "";
  return resolution.endsWith("DUPLICATE");
}

function has_patch(node) {
  return (
    node.attachments &&
    node.attachments.some(
      (attachment) =>
        (attachment.file_name ?? "").startsWith("phabricator-") &&
        !attachment.is_obsolete
    )
  );
}

function is_meta_bug(node) {
  return node.summary.startsWith("[meta]") || node.summary.startsWith("[bugs]");
}

class State {
  static resolved = "resolved";
  static available = "available";
  static inprogress = "inprogress";
  static blockedinprogress = "blockedinprogress";
  static blocked = "blocked";
  static unlandable = "unlandable";
  static review = "review";
  static duplicate = "duplicate";

  static get_status(node, is_empty, leaf) {
    if (duplicate_bug(node)) {
      return State.duplicate;
    }

    if (closed_bug(node)) {
      return State.resolved;
    }

    if (is_empty || leaf) {
      if (has_patch(node)) {
        return State.review;
      }

      if (assigned_bug(node)) {
        return State.inprogress;
      }

      return State.available;
    }

    if (has_patch(node)) {
      return State.unlandable;
    }

    if (assigned_bug(node)) {
      return State.blockedinprogress;
    }

    return State.blocked;
  }
}

function reachable_from(node, nodes) {
  const reachable = {};
  const worklist = [...node.depends_on];

  for (let child = worklist.pop(); child; child = worklist.pop()) {
    if (child in reachable) {
      continue;
    }

    const reachable_child = nodes[child];
    reachable[child] = reachable_child;
    worklist.push(...reachable_child.depends_on);
  }

  return Object.values(reachable);
}

function node_status(nodes, from, to) {
  const from_depends_on = reachable_from(from, nodes);
  const from_depends_on_closed = from_depends_on.filter(
    (node) => closed_bug(node) && !duplicate_bug(node) && !is_meta_bug(node)
  );
  const from_depends_on_total = from_depends_on.filter(
    (node) => !duplicate_bug(node) && !is_meta_bug(node)
  );
  const from_label = `[${from.id} ${from_depends_on_closed.length}/${from_depends_on_total.length}]`;

  const to_depends_on = to.depends_on;
  const to_label = !to_depends_on.length ? `[${to.id}]` : "";

  const empty = !(from_depends_on_total.length - from_depends_on_closed.length);

  const from_status = State.get_status(from, empty, !to);

  return { from_label, to_label, from_status };
}

function get_node(nodes, id) {
  return nodes[id] ?? { id, depends_on: [], status: "" };
}

function htmlencode(str) {
  return str.replaceAll(/["`]/gi, (special, _offset, input) => {
    return `&#${special.charCodeAt(0)};`;
  });
}

async function create_graph(start, max_depth, filter_dups = false) {
  const nodes = await create_nodes(start, max_depth);
  const links = [];
  const interaction = [];
  const bugs = [];
  const styles = [
    "classDef resolved fill:green",
    "classDef available fill:yellow",
    "classDef blocked fill:red",
    "classDef review fill:lightgreen",
    "classDef unlandable fill:lightpink",
    "classDef duplicate fill:teal",
    "classDef bugs stroke:red,stroke-width:2px,stroke-dasharray: 5 5;",
  ];

  const styled = {
    resolved: [],
    available: [],
    inprogress: [],
    blockedinprogress: [],
    blocked: [],
    unlandable: [],
    review: [],
    duplicate: [],
    bugs: [],
  };

  for (const from of Object.values(nodes)) {
    if (filter_dups && duplicate_bug(from)) {
      continue;
    }

    if (from.type === "defect") {
      bugs.push(from);
    }

    for (const to of from.depends_on) {
      const to_node = get_node(nodes, to);
      if (filter_dups && duplicate_bug(to_node)) {
        continue;
      }
      const { from_label, to_label, from_status } = node_status(
        nodes,
        from,
        to_node
      );
      links.push(`${to}${to_label} --> ${from.id}${from_label}`);

      styled[from_status].push(from.id);
    }

    if (!from.depends_on.length) {
      const from_status = State.get_status(from, true, true);
      styled[from_status].push(from.id);

      if (from_status !== "resolved" && from.type === "defect") {
        styled.bugs.push(from.id);
      }
    }

    interaction.push(
      `click ${from.id} "https://bugzilla.mozilla.org/show_bug.cgi?id=${
        from.id
      }" "${htmlencode(from.summary)}" _blank`
    );
  }

  const apply_style = [];
  if (bugs.length) {
    for (const key of Object.keys(styled)) {
      const nodes = styled[key];
      if (!nodes.length) {
        continue;
      }
      apply_style.push(`class ${nodes.join(",")} ${key};`);
    }
  }

  const get_dup_graph = () => {
    const dup_node = [];
    const dup_interaction = [];
    for (const dup of Object.values(nodes).filter(duplicate_bug)) {
      dup_node.push(`${dup.id}:::duplicate`);
      dup_interaction.push(
        `click ${dup.id} "https://bugzilla.mozilla.org/show_bug.cgi?id=${
          dup.id
        }" "${htmlencode(dup.summary)}" _blank`
      );
    }

    return `subgraph "Duplicates"\ndirection TB\n${dup_node.join(
      "\n"
    )}\n${dup_interaction.join("\n")}\nclassDef duplicate fill:teal\nend\n`;
  };
  const graph = `subgraph "Progress"\ndirection LR\n${links.join(
    "\n"
  )}\n${interaction.join("\n")}\nend\n`;

  return `flowchart LR\n${styles.join("\n")}\n${graph}\n${apply_style.join(
    "\n"
  )}\n${filter_dups ? `${get_dup_graph()}\n` : ""}`;
}
