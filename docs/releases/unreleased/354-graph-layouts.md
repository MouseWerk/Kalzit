## Improved

- Graph panels: the layout is now a menu with Forces, Hierarchy, Radial, Circular, Grid, Coordinates and Timeline, each with a short description and the reason when it cannot apply to a result.
- Radial arranges rings around the selected nodes, Coordinates uses two number properties or a `point` property, and Timeline places nodes by a time property in lanes.
- Layouts are computed in the background with progress and Cancel, give the same result every time, and "Arrange again" (Shift+L) is offered for Forces and Radial, where the result can come out differently.
- A hierarchy now handles up to 10,000 drawn nodes, and larger results offer "Close groups".
- Layouts draw quiet guide lines behind the graph (rings, axes, lanes) and show nodes without a value or time in a strip with their number.
