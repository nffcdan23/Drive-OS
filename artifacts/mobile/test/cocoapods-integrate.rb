# What `pod install` does to the app target's build phases, for CI on Linux
# (where pod install itself can't run): CocoaPods' user-target integration
# step for "[CP] Check Pods Manifest.lock" (TargetIntegrator#
# add_check_manifest_lock_script_phase: the phase is moved to the front of the
# target), with CocoaPods' own helper, then the project saved by Xcodeproj as
# pod install saves it. scripts/check-ios-scene-lifecycle.js then checks the
# result, as it does on the Mac after a real pod install.
#
#   ruby test/cocoapods-integrate.rb ios/Derwent.xcodeproj Derwent
require 'cocoapods'

project_path, target_name = ARGV
project = Xcodeproj::Project.open(project_path)
target = project.targets.find { |t| t.name == target_name } or abort "No target #{target_name} in #{project_path}"
phase = Pod::Installer::UserProjectIntegrator::TargetIntegrator.create_or_update_shell_script_build_phase(target, '[CP] Check Pods Manifest.lock')
target.build_phases.unshift(phase).uniq! unless target.build_phases.first == phase
project.save
puts "CocoaPods #{Pod::VERSION} integration: #{target.build_phases.map(&:display_name).join(' -> ')}"
