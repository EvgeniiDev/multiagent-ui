/** Edge-only drawer gestures leave scrolling and content gestures alone. */
export function createDrawerSwipe(options: {
  isEnabled: () => boolean;
  isOpen: () => boolean;
  setOpen: (open: boolean) => void;
}) {
  let gesture: { id: number; x: number; y: number; open: boolean } | null = null;
  const cancel = () => { gesture = null; };
  const interactive = 'input, textarea, select, button, a, [contenteditable], [role="slider"]';

  function start(event: PointerEvent) {
    cancel();
    if (!options.isEnabled() || event.pointerType !== 'touch' || !event.isPrimary) return;
    const open = options.isOpen();
    if (!open && event.clientX > 24) return;
    // Editing a field or using a control must not accidentally close the menu.
    if (open && typeof Element !== 'undefined' && event.target instanceof Element
        && event.target.closest(interactive)) return;
    gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, open };
  }

  function move(event: PointerEvent) {
    if (!gesture || event.pointerId !== gesture.id) return;
    const dx = Math.abs(event.clientX - gesture.x);
    const dy = Math.abs(event.clientY - gesture.y);
    if (dy > 12 && dy > dx) cancel();
  }

  function end(event: PointerEvent) {
    const start = gesture;
    cancel();
    if (!start || event.pointerId !== start.id || !options.isEnabled()
        || options.isOpen() !== start.open) return;
    const dx = event.clientX - start.x;
    const dy = Math.abs(event.clientY - start.y);
    if (Math.abs(dx) < 56 || Math.abs(dx) < dy * 2) return;
    if (!start.open && dx > 0) options.setOpen(true);
    else if (start.open && dx < 0) options.setOpen(false);
  }

  return { start, move, end, cancel };
}
