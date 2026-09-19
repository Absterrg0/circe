#pragma once

#include <react/renderer/components/CirceMarkdownTextSpec/EventEmitters.h>
#include <react/renderer/components/CirceMarkdownTextSpec/Props.h>
#include <react/renderer/components/CirceMarkdownTextSpec/States.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>

namespace facebook::react {
extern const char CirceMarkdownTextRunComponentName[];

using CirceMarkdownTextRunShadowNode = ConcreteViewShadowNode<
    CirceMarkdownTextRunComponentName,
    CirceMarkdownTextRunProps,
    CirceMarkdownTextRunEventEmitter,
    CirceMarkdownTextRunState>;
}
