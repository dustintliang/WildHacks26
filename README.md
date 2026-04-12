# VascuSense


## Description

VascuSense is an automated cerebrovascular analysis platform that detects structural abnormalities in brain arteries from TOF-MRA scans (.nii / .nii.gz) using geometric vessel modeling and rule-based risk scoring. The system processes medical imaging data through a multi-stage pipeline including vessel segmentation, artery labeling, centerline extraction, feature analysis, and AI-assisted report generation.

VascuSense evaluates several clinically relevant vascular conditions:

Aneurysm candidates, detected near arterial bifurcations using vessel expansion and shape deviation metrics
Stenosis (arterial narrowing) measured using NASCET percentage-based radius comparisons
Vessel tortuosity, quantified through curvature-based geometric metrics
Small Vessel Disease indicators, estimated using regional vessel density differences

The platform outputs structured per-artery findings, interpretable risk scores (0–100), and a plain-language clinical-style summary to support rapid screening and visualization of potential abnormalities.

Cerebral aneurysms and vascular narrowing are often asymptomatic before serious events such as stroke or hemorrhage. By automating vessel geometry analysis and highlighting suspicious regions, VascuSense helps support early detection workflows in research and educational imaging environments.

Note: VascuSense is a research tool and does not provide clinical diagnosis.

## Getting Started

### Dependencies

* Describe any prerequisites, libraries, OS version, etc., needed before installing program.
* ex. Windows 10

### Installing

* How/where to download your program
* Any modifications needed to be made to files/folders

### Executing program

* How to run the program
* Step-by-step bullets
```
code blocks for commands
```

## Help

Any advise for common problems or issues.
```
command to run if program contains helper info
```

## Authors

Hub Varith, Jason Ta, Dustin Liang, Vivian Chang


## Version History

* 0.2
    * Various bug fixes and optimizations
    * See [commit change]() or See [release history]()
* 0.1
    * Initial Release

## License

This project is licensed under the [NAME HERE] License - see the LICENSE.md file for details

## Acknowledgments

Inspiration, code snippets, etc.
* [awesome-readme](https://github.com/matiassingers/awesome-readme)
* [PurpleBooth](https://gist.github.com/PurpleBooth/109311bb0361f32d87a2)
* [dbader](https://github.com/dbader/readme-template)
* [zenorocha](https://gist.github.com/zenorocha/4526327)
* [fvcproductions](https://gist.github.com/fvcproductions/1bfc2d4aecb01a834b46)
