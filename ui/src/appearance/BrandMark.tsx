import { Icon } from "../components/Icon";
import { useBrand } from "./brand";
import "./appearance.css";
import { withBase } from "../lib/basePath";

/**
 * The logo an admin uploaded, or the Kalzit mark. Decorative: the product or organization name
 * next to it carries the meaning.
 */
export function BrandMark() {
  const { logoUrl } = useBrand();
  if (logoUrl === null) {
    return <Icon name="logo" />;
  }
  return <img className="brand-mark__img" src={withBase(logoUrl)} alt="" />;
}
