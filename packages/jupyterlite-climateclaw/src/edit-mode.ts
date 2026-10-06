// The chat input's toolbar is drawn under the next message and, where the chat lets a message be
// edited, under that message too. ClimateClaw's controls act on the next message only.

import * as React from "react";

/** The toolbar's props, as far as this goes: whether this input edits a message. */
export interface ToolbarItemProps {
  edit?: boolean;
}

/** `element`, drawn under the next message and nowhere else. */
export function newMessageOnly<P extends ToolbarItemProps>(
  element: React.FunctionComponent<P>,
): React.FunctionComponent<P> {
  return (props) => (props.edit ? null : React.createElement(element, props));
}
