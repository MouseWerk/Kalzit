## Improved

- Edit mode on dashboards does what you click: Edit, Duplicate and the menu in a panel's header
  react to the first click, dragging starts only once the pointer moves, and selecting a panel
  no longer narrows the dashboard or moves panels under the pointer.
- Opening a panel in the editor takes one step: double-click its content, or press E while the
  pointer is over it. Opening a panel's menu selects that panel.
- Saving keeps you in edit mode, and finishing with unsaved changes offers Save next to Discard.
- The panel editor shows the dashboard's variables above the preview; a value chosen there
  re-runs the preview and applies to the dashboard too.

## Fixed

- In narrow panels the menu button no longer falls out of the header: where there is no room,
  the header hides Edit, Duplicate and the size, and the menu keeps Edit and Duplicate.
- The selected panel's size badge no longer covers its content.
- A resized or moved panel takes its new place at once.
- Back from the panel editor, only the edited panel loads again; the others keep their data.

## Checklist for Windows (manual)

- Open a dashboard, choose Edit, click a panel and then Edit in its header with the mouse: the
  panel editor opens. Selecting panels does not change the width of the others, also with a
  visible page scrollbar.
