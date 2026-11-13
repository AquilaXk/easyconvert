use crate::error::Error;

/// Quantization options
pub struct Options {
    max_colors: i32,
    target_mse: f32,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            max_colors: 256,
            target_mse: 0.0,
        }
    }
}

impl Options {
    pub fn get_max_colors(&self) -> i32 {
        self.max_colors
    }

    /// Sets the maximum number of colors in the resultant palette.
    ///
    /// Returns [`Error::ValueOutOfRange`] if the provided number is greater
    /// than 256 or less than 2
    pub fn set_max_colors(&mut self, colors: i32) -> Result<(), Error> {
        if !(2..=256).contains(&colors) {
            return Err(Error::ValueOutOfRange);
        }

        self.max_colors = colors;

        Ok(())
    }

    pub fn get_target_mse(&self) -> f32 {
        self.target_mse
    }

    /// Lets the palette have fewer colours than `max_colors` while the mean squared error of a colour channel stays at or below `mse` (8-bit
    /// units; the error of the alpha channel counts in the sum, which is divided by three). 0 turns it off. (Not in upstream.)
    ///
    /// Returns [`Error::ValueOutOfRange`] if the provided value is negative or not a number
    pub fn set_target_mse(&mut self, mse: f32) -> Result<(), Error> {
        if !(mse >= 0.0) {
            return Err(Error::ValueOutOfRange);
        }

        self.target_mse = mse;

        Ok(())
    }
}
