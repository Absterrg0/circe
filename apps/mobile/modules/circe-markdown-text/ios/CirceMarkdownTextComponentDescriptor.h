#pragma once

#include "CirceMarkdownTextShadowNode.h"

#include <react/renderer/core/ConcreteComponentDescriptor.h>
#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>

namespace facebook::react {
using CirceMarkdownTextComponentDescriptor = ConcreteComponentDescriptor<CirceMarkdownTextShadowNode>;

void CirceMarkdownTextSpec_registerComponentDescriptorsFromCodegen(
  std::shared_ptr<const ComponentDescriptorProviderRegistry> registry);
}
