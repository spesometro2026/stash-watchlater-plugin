(function () {
  "use strict";
  const api = window.PluginApi;
  const { React, patch, libraries, register } = api;
  // Use Link (not a plain <a href>): a plain <a> triggers a full page load, which hits the
  // server and 404s on /plugin/watchlater (the route only exists client-side, not server-side) -
  // real bug found and fixed by testing live in the browser.
  const { Link } = libraries.ReactRouterDOM;

  const TAG_NAME = "Watch Later";
  const LIST_PREFIX = "Watch Later: ";
  const KOFI_URL = "https://ko-fi.com/greenthumb80";
  const FEEDBACK_URL = "https://github.com/spesometro2026/stash-watchlater-plugin/issues/new";
  let tagId = null;
  let tagPromise = null;
  // ids of the root tag + every sub-list tag, so we can tell "any Watch Later membership"
  // apart from unrelated tags when moving a scene between lists. Populated by ensureLists().
  let familyIds = new Set();

  async function gql(query, variables) {
    const res = await fetch("/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ query, variables }),
    });
    const out = await res.json();
    if (out.errors) throw new Error(out.errors[0].message);
    return out.data;
  }

  function ensureTag() {
    if (tagPromise) return tagPromise;
    tagPromise = (async () => {
      const found = await gql(
        "query($f: TagFilterType) { findTags(tag_filter: $f) { tags { id name } } }",
        { f: { name: { value: TAG_NAME, modifier: "EQUALS" } } }
      );
      if (found.findTags.tags.length) {
        tagId = found.findTags.tags[0].id;
        familyIds.add(tagId);
        return tagId;
      }
      const created = await gql(
        "mutation($input: TagCreateInput!) { tagCreate(input: $input) { id } }",
        { input: { name: TAG_NAME, description: "Created by the Watch Later plugin" } }
      );
      tagId = created.tagCreate.id;
      familyIds.add(tagId);
      return tagId;
    })();
    return tagPromise;
  }

  // Lists = the root "Watch Later" tag ("All") plus its child tags ("Watch Later: <name>").
  // Kept as plain Stash tag hierarchy - no state of our own, browsable/filterable outside the
  // plugin too, same reasoning as the root tag itself.
  async function ensureLists() {
    const rootId = await ensureTag();
    const d = await gql(
      "query($id: ID!) { findTag(id: $id) { children { id name } } }",
      { id: rootId }
    );
    const children = (d.findTag && d.findTag.children) || [];
    familyIds = new Set([rootId, ...children.map((c) => c.id)]);
    return {
      rootId,
      lists: [
        { id: rootId, name: "All" },
        ...children.map((c) => ({
          id: c.id,
          name: c.name.startsWith(LIST_PREFIX) ? c.name.slice(LIST_PREFIX.length) : c.name,
        })),
      ],
    };
  }

  // One lookup per page load, shared by every button (cards and the scene page) - not one per card.
  let familyPromise = null;
  function ensureFamily() {
    if (!familyPromise) familyPromise = ensureLists();
    return familyPromise;
  }

  // A scene is "queued" if it carries the root tag or any list tag (child of the root).
  function isQueued(tags) {
    return (tags || []).some((t) => familyIds.has(t.id));
  }

  // Queue / unqueue in one mutation. Adding puts the scene on the root list ("All"); removing drops every
  // Watch Later family tag it carries (root and any list), leaving unrelated tags untouched.
  // Returns the scene's fresh tag list, so callers don't keep working from a stale copy.
  async function setQueued(sceneId, currentTags, queue) {
    const { rootId } = await ensureFamily();
    const currentIds = (currentTags || []).map((t) => t.id);
    const newIds = queue
      ? Array.from(new Set([...currentIds, rootId]))
      : currentIds.filter((x) => !familyIds.has(x));
    const out = await gql(
      "mutation($input: SceneUpdateInput!) { sceneUpdate(input: $input) { id tags { id name } } }",
      { input: { id: sceneId, tag_ids: newIds } }
    );
    return out.sceneUpdate.tags;
  }

  async function createList(name) {
    familyPromise = null; // the family changes: refetch next time
    const rootId = await ensureTag();
    const created = await gql(
      "mutation($input: TagCreateInput!) { tagCreate(input: $input) { id } }",
      {
        input: {
          name: `${LIST_PREFIX}${name}`,
          parent_ids: [rootId],
          description: "Watch Later list, created by the Watch Later plugin",
        },
      }
    );
    familyIds.add(created.tagCreate.id);
    return created.tagCreate.id;
  }

  async function removeFromWatchLater(scene, listTagId) {
    const tid = listTagId || (await ensureTag());
    const currentIds = (scene.tags || []).map((t) => t.id);
    await gql(
      "mutation($input: SceneUpdateInput!) { sceneUpdate(input: $input) { id } }",
      { input: { id: scene.id, tag_ids: currentIds.filter((x) => x !== tid) } }
    );
  }

  // Moves a scene to exactly one list: drops any other Watch Later family tag it might carry
  // (root or another sub-list) and applies the target one, leaving unrelated tags untouched.
  async function moveSceneToList(scene, targetListId) {
    const currentIds = (scene.tags || []).map((t) => t.id);
    const withoutFamily = currentIds.filter((x) => !familyIds.has(x));
    await gql(
      "mutation($input: SceneUpdateInput!) { sceneUpdate(input: $input) { id } }",
      { input: { id: scene.id, tag_ids: [...withoutFamily, targetListId] } }
    );
  }

  // ------------------------------------------------------------------ shared queue state
  // "on" is real React state (not re-derived from scene.tags on every render): mutating scene.tags in place does
  // NOT trigger a re-render, which was the root cause of an old "needs a reload to see the change" bug. It is
  // flipped explicitly once the click is applied (optimistically), and re-synced when the scene's tags change.
  function useQueued(scene) {
    const [on, setOn] = React.useState(() => isQueued(scene.tags));
    const [busy, setBusy] = React.useState(false);
    const tagsRef = React.useRef(scene.tags || []);

    React.useEffect(() => {
      tagsRef.current = scene.tags || [];
      let alive = true;
      ensureFamily().then(() => {
        if (alive) setOn(isQueued(tagsRef.current));
      });
      return () => {
        alive = false;
      };
    }, [scene.id, scene.tags]);

    async function toggle(e) {
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      if (busy) return;
      const prevOn = on;
      setOn(!prevOn); // optimistic: don't make the click feel dead while the GraphQL round-trip runs
      setBusy(true);
      try {
        tagsRef.current = await setQueued(scene.id, tagsRef.current, !prevOn);
        setOn(isQueued(tagsRef.current));
      } catch (err) {
        console.error("[Watch Later] toggle error:", err);
        setOn(prevOn);
      } finally {
        setBusy(false);
      }
    }
    return { on, busy, toggle };
  }

  // ------------------------------------------------------------------ card button (grid)
  function WatchLaterButton({ scene }) {
    const { on, busy, toggle } = useQueued(scene);
    return React.createElement(
      "div",
      { className: "watch-later-overlay" },
      React.createElement(
        "button",
        {
          className: "watch-later-btn minimal" + (on ? " watch-later-on" : ""),
          title: on ? "Remove from Watch Later" : "Add to Watch Later",
          onClick: toggle,
          disabled: busy,
        },
        "🔖"
      )
    );
  }

  patch.instead("SceneCard.Overlays", function (props, _ctx, orig) {
    return React.createElement(
      React.Fragment,
      null,
      orig(props, _ctx),
      React.createElement(WatchLaterButton, { scene: props.scene })
    );
  });

  // ------------------------------------------------------------------ single scene page
  // Same bookmark on the scene's own page, in the toolbar next to rating / counters / operations menu.
  function SceneWatchLaterButton({ scene, floating }) {
    const { on, busy, toggle } = useQueued(scene);
    return React.createElement(
      "button",
      {
        className:
          "watchlater-scene-btn btn btn-secondary minimal" +
          (on ? " watch-later-on" : "") +
          (floating ? " watchlater-scene-floating" : ""),
        title: on ? "Remove from Watch Later" : "Add to Watch Later",
        onClick: toggle,
        disabled: busy,
      },
      "🔖"
    );
  }

  // Walks the element tree ScenePage returned and appends `make()` to the LAST ".scene-toolbar-group" (the one with
  // the counters and the operations menu). Elements are immutable, so the path to it is cloned. Returns
  // { node, done }: done=false means the toolbar wasn't found (Stash changed the page) and the caller falls back.
  function injectIntoToolbar(node, make) {
    if (!React.isValidElement(node)) return { node, done: false };
    const props = node.props || {};
    const children = props.children;
    let found = null;
    let newChildren = children;
    if (children != null) {
      const list = React.Children.toArray(children);
      for (let i = list.length - 1; i >= 0; i--) {
        const r = injectIntoToolbar(list[i], make);
        if (r.done) {
          list[i] = r.node;
          found = true;
          break;
        }
      }
      if (found) return { node: React.cloneElement(node, undefined, ...list), done: true };
    }
    if (typeof props.className === "string" && /(^|\s)scene-toolbar-group(\s|$)/.test(props.className)) {
      const list = React.Children.toArray(children);
      return { node: React.cloneElement(node, undefined, ...list, make()), done: true };
    }
    return { node, done: false };
  }

  patch.after("ScenePage", function (props, _ctx, result) {
    try {
      const scene = props && props.scene;
      if (!scene) return result;
      const out = injectIntoToolbar(result, () =>
        React.createElement(
          "span",
          { key: "watchlater-scene", className: "watchlater-scene-toolbar-item" },
          React.createElement(SceneWatchLaterButton, { scene })
        )
      );
      if (out.done) return out.node;
      // toolbar not found: keep working with a floating button instead of silently doing nothing
      return React.createElement(
        React.Fragment,
        null,
        result,
        React.createElement(SceneWatchLaterButton, { scene, floating: true })
      );
    } catch (err) {
      console.error("[Watch Later] scene page patch error:", err);
      return result;
    }
  });

  // ------------------------------------------------------------------ dedicated page
  function fmtDuration(sec) {
    if (!sec) return "";
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  function WatchLaterCard({ scene, onRemoved, lists, activeListId, onMoved }) {
    const [removing, setRemoving] = React.useState(false);
    const [moving, setMoving] = React.useState(false);
    const file = scene.files && scene.files[0];

    async function remove(e) {
      e.preventDefault();
      e.stopPropagation();
      if (removing) return;
      setRemoving(true);
      try {
        await removeFromWatchLater(scene, activeListId);
        onRemoved(scene.id);
      } catch (err) {
        console.error("[Watch Later] remove error:", err);
        setRemoving(false);
      }
    }

    async function moveTo(e) {
      const targetId = e.target.value;
      if (!targetId || targetId === activeListId || moving) return;
      setMoving(true);
      try {
        await moveSceneToList(scene, targetId);
        onMoved(scene.id);
      } catch (err) {
        console.error("[Watch Later] move error:", err);
        setMoving(false);
      }
    }

    return React.createElement(
      "div",
      { className: "watchlater-row" },
      React.createElement(
        Link,
        { to: `/scenes/${scene.id}`, className: "watchlater-row-thumb-link" },
        React.createElement("img", {
          className: "watchlater-row-thumb",
          loading: "lazy",
          src: scene.paths && scene.paths.screenshot,
          alt: "",
        }),
        file && file.duration
          ? React.createElement(
              "span",
              { className: "watchlater-row-duration" },
              fmtDuration(file.duration)
            )
          : null
      ),
      React.createElement(
        "div",
        { className: "watchlater-row-body" },
        React.createElement(
          Link,
          { to: `/scenes/${scene.id}`, className: "watchlater-row-title" },
          scene.title || (file ? file.basename : "") || `Scene #${scene.id}`
        ),
        scene.studio
          ? React.createElement(
              "div",
              { className: "watchlater-row-studio" },
              scene.studio.name
            )
          : null,
        scene.performers && scene.performers.length
          ? React.createElement(
              "div",
              { className: "watchlater-row-performers" },
              scene.performers.map((p) => p.name).join(", ")
            )
          : null,
        // Watch Later family tags (root + every list) aren't informative here, exclude them.
        scene.tags && scene.tags.some((t) => !familyIds.has(t.id))
          ? React.createElement(
              "div",
              { className: "watchlater-row-tags" },
              scene.tags
                .filter((t) => !familyIds.has(t.id))
                .map((t) => t.name)
                .join(" · ")
            )
          : null
      ),
      lists && lists.length > 1
        ? React.createElement(
            "div",
            { className: "watchlater-move-select-wrap", title: "Move to another list" },
            "➜",
            React.createElement(
              "select",
              {
                className: "watchlater-move-select",
                value: activeListId,
                onChange: moveTo,
                disabled: moving,
              },
              lists.map((l) =>
                React.createElement("option", { key: l.id, value: l.id }, l.name)
              )
            )
          )
        : null,
      React.createElement(
        "button",
        {
          className: "watchlater-remove-btn minimal",
          title: "Remove from this list",
          onClick: remove,
          disabled: removing,
        },
        "🔖"
      )
    );
  }

  function WatchLaterPage() {
    const [scenes, setScenes] = React.useState(null);
    const [error, setError] = React.useState(null);
    const [autoRemoved, setAutoRemoved] = React.useState(0);
    const [lists, setLists] = React.useState(null);
    const [activeListId, setActiveListId] = React.useState(null);

    React.useEffect(() => {
      let alive = true;
      ensureLists().then(({ rootId, lists: ls }) => {
        if (!alive) return;
        setLists(ls);
        setActiveListId((prev) => prev || rootId);
      });
      return () => {
        alive = false;
      };
    }, []);

    // "updated_at" is used as a stand-in for "date added to a list": Stash doesn't keep a
    // per-tag timestamp, but tagging a scene bumps its updated_at - so the most recently added
    // scene ends up on top, as requested ("sort by when it was added, not by name").
    const load = React.useCallback(async () => {
      if (!activeListId) return;
      try {
        const d = await gql(
          `query($id: ID!) {
            findScenes(
              scene_filter: { tags: { modifier: INCLUDES, value: [$id] } }
              filter: { per_page: -1, sort: "updated_at", direction: DESC }
            ) {
              count
              scenes {
                id title date updated_at play_history
                studio { name }
                files { basename duration }
                paths { screenshot }
                tags { id name }
                performers { id name }
              }
            }
          }`,
          { id: activeListId }
        );
        const fetched = d.findScenes.scenes;

        // Auto-remove scenes watched since they were added to this list: "updated_at" is our
        // only proxy for "when added" (see the comment above), so a scene counts as
        // watched-since-add if any play_history entry is newer than it. Fires the removal in
        // the background; the UI already reflects the filtered list.
        const stillPending = [];
        const toAutoRemove = [];
        for (const s of fetched) {
          const watchedSinceAdd = (s.play_history || []).some(
            (t) => new Date(t) > new Date(s.updated_at)
          );
          (watchedSinceAdd ? toAutoRemove : stillPending).push(s);
        }
        setScenes(stillPending);
        setAutoRemoved(toAutoRemove.length);
        for (const s of toAutoRemove) {
          removeFromWatchLater(s, activeListId).catch((err) =>
            console.error("[Watch Later] auto-remove error:", err)
          );
        }
      } catch (err) {
        console.error("[Watch Later] load error:", err);
        setError(String(err));
      }
    }, [activeListId]);

    React.useEffect(() => {
      load();
    }, [load]);

    async function newList() {
      const name = window.prompt("New list name:");
      if (!name || !name.trim()) return;
      try {
        const id = await createList(name.trim());
        setLists((prev) => [...(prev || []), { id, name: name.trim() }]);
        setActiveListId(id);
      } catch (err) {
        console.error("[Watch Later] create list error:", err);
      }
    }

    function onMoved(id) {
      setScenes((prev) => (prev || []).filter((s) => s.id !== id));
    }

    function onRemoved(id) {
      setScenes((prev) => (prev || []).filter((s) => s.id !== id));
    }

    function exportList() {
      const rows = (scenes || []).map((s) => ({
        title: s.title || (s.files && s.files[0] && s.files[0].basename) || "",
        studio: (s.studio && s.studio.name) || "",
        performers: (s.performers || []).map((p) => p.name).join(", "),
        date: s.date || "",
        duration_seconds: (s.files && s.files[0] && s.files[0].duration) || null,
        url: `${location.origin}/scenes/${s.id}`,
      }));
      const blob = new Blob([JSON.stringify(rows, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "watch-later.json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    }

    const exportLink = React.createElement(
      "a",
      {
        className: "watchlater-kofi-link",
        href: "#",
        title: "Export this list as JSON",
        onClick: (e) => {
          e.preventDefault();
          exportList();
        },
      },
      "⬇ Export"
    );

    const kofiLink = React.createElement(
      "a",
      {
        className: "watchlater-kofi-link",
        href: KOFI_URL,
        target: "_blank",
        rel: "noopener noreferrer",
        title: "Support this plugin",
      },
      "☕ Buy me a coffee"
    );

    const feedbackLink = React.createElement(
      "a",
      {
        className: "watchlater-kofi-link",
        href: FEEDBACK_URL,
        target: "_blank",
        rel: "noopener noreferrer",
        title: "Suggest a feature or report a bug",
      },
      "💡 Suggest a feature"
    );

    const pageLinks = React.createElement(
      "div",
      { className: "watchlater-page-links" },
      exportLink,
      feedbackLink,
      kofiLink
    );

    const listSelector =
      lists && lists.length
        ? React.createElement(
            "div",
            { className: "watchlater-list-selector" },
            lists.map((l) =>
              React.createElement(
                "button",
                {
                  key: l.id,
                  className:
                    "minimal watchlater-list-tab" +
                    (l.id === activeListId ? " watchlater-list-tab-active" : ""),
                  onClick: () => setActiveListId(l.id),
                },
                l.name
              )
            ),
            React.createElement(
              "button",
              { className: "minimal watchlater-new-list-btn", onClick: newList },
              "+ New list"
            )
          )
        : null;

    if (error) {
      return React.createElement(
        "div",
        { className: "watchlater-page" },
        React.createElement("h3", null, "Watch Later"),
        React.createElement("p", { className: "text-danger" }, "Error: " + error)
      );
    }

    if (scenes === null) {
      return React.createElement(
        "div",
        { className: "watchlater-page" },
        React.createElement("h3", null, "Watch Later"),
        React.createElement("p", null, "Loading…")
      );
    }

    return React.createElement(
      "div",
      { className: "watchlater-page" },
      React.createElement(
        "div",
        { className: "watchlater-page-header" },
        React.createElement("h3", null, `Watch Later (${scenes.length})`),
        pageLinks
      ),
      listSelector,
      autoRemoved > 0
        ? React.createElement(
            "p",
            { className: "watchlater-auto-removed-note" },
            `${autoRemoved} scene${autoRemoved === 1 ? "" : "s"} auto-removed: already watched since being added.`
          )
        : null,
      scenes.length === 0
        ? React.createElement(
            "p",
            null,
            "Empty for now. Click the bookmark icon on a scene to add it here."
          )
        : React.createElement(
            "div",
            { className: "watchlater-list" },
            scenes.map((s) =>
              React.createElement(WatchLaterCard, {
                key: s.id,
                scene: s,
                onRemoved,
                onMoved,
                lists,
                activeListId,
              })
            )
          )
    );
  }

  register.route("/plugin/watchlater", WatchLaterPage);

  patch.before("MainNavBar.UtilityItems", function (props) {
    return [
      {
        children: React.createElement(
          React.Fragment,
          null,
          props.children,
          React.createElement(
            Link,
            {
              className: "nav-utility watchlater-nav-link",
              to: "/plugin/watchlater",
              title: "Watch Later",
            },
            React.createElement(
              "button",
              { className: "minimal d-flex align-items-center h-100" },
              "🔖"
            )
          )
        ),
      },
    ];
  });
})();
