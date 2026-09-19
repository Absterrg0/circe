#pragma once

#include "CirceMarkdownTextRunShadowNode.h"

#include <react/renderer/core/ConcreteComponentDescriptor.h>
#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>

namespace facebook::react {
using CirceMarkdownTextRunComponentDescriptor = ConcreteComponentDescriptor<CirceMarkdownTextRunShadowNode>;

void CirceMarkdownTextRunSpec_registerComponentDescriptorsFromCodegen(
  std::shared_ptr<const ComponentDescriptorProviderRegistry> registry);
}
