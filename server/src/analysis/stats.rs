//! Statistics over the values of a field. Empty values are left out; with no value left, every
//! measure but `count` is empty. The UI computes the same in `ui/src/analysis/stats.ts`, in the
//! same order of operations, so both give the same digits.

/// The arithmetic mean; sums in row order.
pub fn mean(values: &[f64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    Some(sum(values) / values.len() as f64)
}

pub fn sum(values: &[f64]) -> f64 {
    values.iter().fold(0.0, |acc, v| acc + v)
}

/// The `p`th percentile (0 to 100) of sorted values, interpolating linearly between the two
/// closest ranks (as Excel's PERCENTILE.INC). The median is the 50th.
pub fn percentile(sorted: &[f64], p: f64) -> Option<f64> {
    if sorted.is_empty() {
        return None;
    }
    let rank = p / 100.0 * (sorted.len() - 1) as f64;
    let lo = rank.floor() as usize;
    let hi = rank.ceil() as usize;
    let (a, b) = (sorted[lo], sorted[hi.min(sorted.len() - 1)]);
    Some(a + (b - a) * (rank - lo as f64))
}

pub fn sorted(values: &[f64]) -> Vec<f64> {
    let mut s = values.to_vec();
    s.sort_by(f64::total_cmp);
    s
}

/// The sample standard deviation (n - 1, as Excel's STDEV.S); needs two values.
pub fn stddev(values: &[f64]) -> Option<f64> {
    if values.len() < 2 {
        return None;
    }
    let m = mean(values)?;
    let squares = values.iter().fold(0.0, |acc, v| acc + (v - m) * (v - m));
    Some((squares / (values.len() - 1) as f64).sqrt())
}

pub fn min(values: &[f64]) -> Option<f64> {
    values.iter().copied().reduce(f64::min)
}

pub fn max(values: &[f64]) -> Option<f64> {
    values.iter().copied().reduce(f64::max)
}

/// A least-squares line through the points.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Line {
    pub slope: f64,
    pub intercept: f64,
    /// The coefficient of determination; empty when y does not vary.
    pub r2: Option<f64>,
    pub n: usize,
}

/// The regression line of y over x; needs two points with different x. Centered on the means,
/// so large x (Unix ms) lose no precision in the squares.
pub fn regression(points: &[(f64, f64)]) -> Option<Line> {
    if points.len() < 2 {
        return None;
    }
    let n = points.len() as f64;
    let mx = points.iter().fold(0.0, |acc, p| acc + p.0) / n;
    let my = points.iter().fold(0.0, |acc, p| acc + p.1) / n;
    let (mut sxx, mut sxy, mut syy) = (0.0, 0.0, 0.0);
    for (x, y) in points {
        let (dx, dy) = (x - mx, y - my);
        sxx += dx * dx;
        sxy += dx * dy;
        syy += dy * dy;
    }
    if sxx == 0.0 {
        return None;
    }
    let slope = sxy / sxx;
    let r2 = if syy == 0.0 { None } else { Some(sxy * sxy / (sxx * syy)) };
    Some(Line { slope, intercept: my - slope * mx, r2, n: points.len() })
}

/// Pearson's correlation coefficient; needs two points and both series varying.
pub fn correlation(points: &[(f64, f64)]) -> Option<f64> {
    if points.len() < 2 {
        return None;
    }
    let n = points.len() as f64;
    let mx = points.iter().fold(0.0, |acc, p| acc + p.0) / n;
    let my = points.iter().fold(0.0, |acc, p| acc + p.1) / n;
    let (mut sxx, mut sxy, mut syy) = (0.0, 0.0, 0.0);
    for (x, y) in points {
        let (dx, dy) = (x - mx, y - my);
        sxx += dx * dx;
        sxy += dx * dy;
        syy += dy * dy;
    }
    if sxx == 0.0 || syy == 0.0 {
        return None;
    }
    Some((sxy / (sxx.sqrt() * syy.sqrt())).clamp(-1.0, 1.0))
}

/// The trailing moving average over `window` rows: empty until the window is full, then the mean
/// of the values in it that are not empty (empty if none is).
/// Rows between two fresh sums of the moving window.
const RESUM_EVERY: usize = 1024;

pub fn moving_average(values: &[Option<f64>], window: usize) -> Vec<Option<f64>> {
    let window = window.max(1);
    let mut out = Vec::with_capacity(values.len());
    let (mut total, mut count) = (0.0, 0usize);
    for (i, v) in values.iter().enumerate() {
        if let Some(x) = v {
            total += x;
            count += 1;
        }
        if i >= window
            && let Some(old) = values[i - window]
        {
            total -= old;
            count -= 1;
        }
        // Adding and taking away leaves rounding behind; the window's sum is taken afresh now and
        // then, so it cannot drift over long series (after a huge value left, for example).
        if (i + 1) % RESUM_EVERY == 0 {
            total = values[(i + 1).saturating_sub(window)..=i].iter().flatten().fold(0.0, |acc, x| acc + x);
        }
        out.push(if i + 1 < window || count == 0 { None } else { Some(total / count as f64) });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() <= 1e-9 * a.abs().max(b.abs()).max(1.0)
    }

    #[test]
    fn known_values() {
        let v = [2.0, 4.0, 4.0, 4.0, 5.0, 5.0, 7.0, 9.0];
        assert_eq!(sum(&v), 40.0);
        assert_eq!(mean(&v), Some(5.0));
        // Sample standard deviation of the classic example: sqrt(32 / 7).
        assert!(close(stddev(&v).unwrap(), (32.0f64 / 7.0).sqrt()));
        let s = sorted(&[3.0, 1.0, 4.0, 1.0, 5.0, 9.0, 2.0, 6.0]);
        assert_eq!(percentile(&s, 50.0), Some(3.5));
        assert_eq!(percentile(&s, 0.0), Some(1.0));
        assert_eq!(percentile(&s, 100.0), Some(9.0));
        // Excel: PERCENTILE.INC({1,1,2,3,4,5,6,9}, 0.9) = 6.9
        assert!(close(percentile(&s, 90.0).unwrap(), 6.9));
        assert!(close(percentile(&s, 25.0).unwrap(), 1.75));
        assert_eq!(percentile(&[7.0], 90.0), Some(7.0));
        assert_eq!((min(&v), max(&v)), (Some(2.0), Some(9.0)));
    }

    #[test]
    fn nothing_and_single_values() {
        assert_eq!(mean(&[]), None);
        assert_eq!(percentile(&[], 50.0), None);
        assert_eq!(stddev(&[1.0]), None);
        assert_eq!(min(&[]), None);
        assert_eq!(regression(&[(1.0, 1.0)]), None);
        assert_eq!(regression(&[(1.0, 1.0), (1.0, 2.0)]), None, "x does not vary");
        assert_eq!(correlation(&[(1.0, 1.0), (2.0, 1.0)]), None, "y does not vary");
    }

    #[test]
    fn regression_and_correlation() {
        let line = regression(&[(1.0, 2.0), (2.0, 4.1), (3.0, 5.9), (4.0, 8.2)]).unwrap();
        assert!(close(line.slope, 2.04), "{line:?}");
        assert!(close(line.intercept, -0.05), "{line:?}");
        assert!(close(line.r2.unwrap(), 104.04 / 104.25), "{line:?}");
        // Times in ms keep their precision.
        let day = 86_400_000.0;
        let t0 = 1_800_000_000_000.0;
        let line = regression(&[(t0, 10.0), (t0 + day, 12.0), (t0 + 2.0 * day, 14.0)]).unwrap();
        assert!(close(line.slope * day, 2.0), "{line:?}");
        assert_eq!(line.r2, Some(1.0));
        assert!(close(correlation(&[(1.0, 2.0), (2.0, 4.0), (3.0, 6.0)]).unwrap(), 1.0));
        assert!(close(correlation(&[(1.0, 3.0), (2.0, 2.0), (3.0, 1.0)]).unwrap(), -1.0));
        // x = 1..5, y = 2,4,5,4,5: r = 0.7745966692414834
        let r = correlation(&[(1.0, 2.0), (2.0, 4.0), (3.0, 5.0), (4.0, 4.0), (5.0, 5.0)]).unwrap();
        assert!(close(r, 0.774_596_669_241_483_4), "{r}");
    }

    #[test]
    fn moving_averages_wait_for_a_full_window() {
        let v = [Some(1.0), Some(2.0), Some(3.0), None, Some(5.0), None, None];
        assert_eq!(moving_average(&v, 3), [None, None, Some(2.0), Some(2.5), Some(4.0), Some(5.0), Some(5.0)]);
        assert_eq!(moving_average(&v, 1), [Some(1.0), Some(2.0), Some(3.0), None, Some(5.0), None, None]);
        assert_eq!(moving_average(&[], 3), Vec::<Option<f64>>::new());
        // A huge value passing through the window leaves no rounding behind for long.
        let mut v = vec![Some(1e17)];
        v.extend(std::iter::repeat_n(Some(0.1), 3000));
        let out = moving_average(&v, 2);
        assert_eq!(out[2047], Some(0.1), "{:?}", out[2047]);
    }
}
