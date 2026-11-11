/**
 * Docker Manager — Native GPUI Docker & Compose management panel.
 *
 * Implements the panel layout, toolbar, section switcher, filter input,
 * and base view lifecycle.
 *
 * References:
 * - docs/SPEC.md: DM-10 (Toolbar), DM-11 (Section switcher), DM-12 (Filter box),
 *   DM-13 (Virtualized list), DM-14 (Row interactions), DM-15 (Engine detection)
 * - docs/DESIGN.md: Section 2 (Dual-Mode View Architecture)
 */

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import { theme, props, shared, setShared } from "herdr";

/** Available section keys in panel mode (DM-11). */
const SECTIONS = [
  { id: "containers", label: "Containers", icon: "container" },
  { id: "images", label: "Images", icon: "layers" },
  { id: "volumes", label: "Volumes", icon: "volume" },
  { id: "networks", label: "Networks", icon: "network" },
  { id: "system", label: "System", icon: "system" },
];

export default class DockerManager extends View {
  /**
   * Initializes the Docker Manager view (DM-02).
   *
   * @param {Record<string, any>} _props
   * @param {import("gpui-kit").ViewContext} cx
   */
  init(_props, cx) {
    this.closed = false;
    const p = props() || {};

    // Mode determination: inspector tab mode vs panel mode (DESIGN Section 2)
    this.inspectMode = Boolean(p.inspect);
    this.inspectTarget = p.inspect || null;

    // Panel state
    this.section = "containers";
    this.scope = "all"; // "all" | "space" (DM-35, DM-36)
    this.engineStatus = "connected"; // "connected" | "connecting" | "unreachable"
    this.engineVersion = "Docker";
    this.filterText = "";

    // Retained input state (must NOT be instantiated inside render)
    this.filterInput = InputState.new({ placeholder: "Filter containers, images, ports…" });
    this.filterInput.on("change", (_e, cx) => {
      this.filterText = (this.filterInput.value() || "").toLowerCase().trim();
      cx.notify();
    });
  }

  /**
   * Lifecycle cleanup.
   *
   * @param {import("gpui-kit").AsyncContext} _cx
   */
  async close(_cx) {
    this.closed = true;
    this.filterInput = null;
  }

  /**
   * Renders the top toolbar (DM-10).
   *
   * @param {ReturnType<typeof theme>} t
   * @param {import("gpui-kit").ViewContext} _cx
   */
  renderToolbar(t, _cx) {
    const isConnected = this.engineStatus === "connected";
    const statusColor = isConnected ? t.done || "#2ea043" : t.blocked || "#e05252";

    return h_flex()
      .h(38)
      .w_full()
      .px(10)
      .items_center()
      .justify_between()
      .bg(t.chrome)
      .border_b_1()
      .border_color(t.border)
      .child(
        h_flex()
          .items_center()
          .gap(6)
          // Engine status dot + Title
          .child(div().w(7).h(7).rounded_full().bg(statusColor))
          .child(
            div()
              .font_semibold()
              .text_size(12)
              .text_color(t.foreground)
              .child(this.engineVersion)
          )
      )
      .child(
        h_flex()
          .items_center()
          .gap(6)
          // Scope toggle placeholder (DM-35, DM-36)
          .child(
            h_flex()
              .items_center()
              .rounded(5)
              .bg(t.surface)
              .border_1()
              .border_color(t.border)
              .p(2)
              .gap(2)
              .child(
                div()
                  .px(6)
                  .py(2)
                  .rounded(3)
                  .text_size(10.5)
                  .when(this.scope === "space", (el) =>
                    el.bg(t.selected).text_color(t.foreground).font_semibold()
                  )
                  .when(this.scope !== "space", (el) =>
                    el.text_color(t.dim)
                  )
                  .child("Space")
              )
              .child(
                div()
                  .px(6)
                  .py(2)
                  .rounded(3)
                  .text_size(10.5)
                  .when(this.scope === "all", (el) =>
                    el.bg(t.selected).text_color(t.foreground).font_semibold()
                  )
                  .when(this.scope !== "all", (el) =>
                    el.text_color(t.dim)
                  )
                  .child("All")
              )
          )
          // Refresh button
          .child(
            div()
              .w(24)
              .h(24)
              .rounded(4)
              .items_center()
              .justify_center()
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .child(svg("mods/docker-manager/icons/refresh.svg").size(12).text_color(t.muted))
          )
      );
  }

  /**
   * Renders the section switcher bar (DM-11).
   *
   * @param {ReturnType<typeof theme>} t
   * @param {import("gpui-kit").ViewContext} _cx
   */
  renderSectionSwitcher(t, _cx) {
    return h_flex()
      .h(32)
      .w_full()
      .px(8)
      .items_center()
      .gap(4)
      .bg(t.surface)
      .border_b_1()
      .border_color(t.border)
      .children(
        SECTIONS.map((sec) => {
          const isActive = this.section === sec.id;
          return div()
            .id(sec.id)
            .px(8)
            .py(3)
            .rounded(4)
            .text_size(11)
            .cursor_pointer()
            .when(isActive, (el) =>
              el.bg(t.selected).text_color(t.foreground).font_semibold()
            )
            .when(!isActive, (el) =>
              el.text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
            )
            .child(sec.label);
        })
      );
  }

  /**
   * Renders the filter input (DM-12).
   *
   * @param {ReturnType<typeof theme>} t
   * @param {import("gpui-kit").ViewContext} _cx
   */
  renderFilterBar(t, _cx) {
    return h_flex()
      .h(32)
      .w_full()
      .px(8)
      .items_center()
      .bg(t.background)
      .border_b_1()
      .border_color(t.border)
      .child(
        h_flex()
          .w_full()
          .h(24)
          .px(6)
          .items_center()
          .rounded(4)
          .bg(t.input)
          .border_1()
          .border_color(t.border)
          .child(
            Input.new(this.filterInput)
              .h_full()
              .w_full()
              .text_size(11)
              .text_color(t.foreground)
          )
      );
  }

  /**
   * Renders the view (GPUI render cycle).
   *
   * @param {import("gpui-kit").ViewContext} cx
   */
  render(cx) {
    const t = theme();

    return v_flex()
      .size_full()
      .bg(t.background)
      .text_color(t.foreground)
      .child(this.renderToolbar(t, cx))
      .child(this.renderSectionSwitcher(t, cx))
      .child(this.renderFilterBar(t, cx))
      .child(
        v_flex()
          .flex_1()
          .items_center()
          .justify_center()
          .p(16)
          .child(
            div()
              .text_size(12)
              .text_color(t.muted)
              .child("Docker Manager ready. No active containers.")
          )
      );
  }
}
